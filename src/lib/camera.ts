// Browser camera wrapper: opens the back camera, exposes manual exposure/ISO control
// (Chrome on Android, Image Capture constraints) and turns frames into FrameSamples:
// aligned against hand shake, then averaged into a 2D grid of cells.

import type { FrameSample } from './analysis';
import type { MeasureCamera, Range } from './measure';
import { Registrar, bilinear } from './register';

type Caps = Record<string, unknown>;
type RawRange = { min: number; max: number; step?: number };

/** Long side of the downscaled frame used for alignment and analysis, in pixels. */
const ANALYSIS_LONG = 320;
/** Cell size of the analysis grid, in downscaled pixels. */
const CELL = 3;
/** Analysed part of the frame (centred, fraction of each side); the rest is margin for hand shake. */
export const REGION = 0.7;
/** exposureTime constraint unit: 100 microseconds. */
const EXPOSURE_UNIT = 1e-4;
/** Below this correlation peak an alignment estimate is not trusted. */
const MIN_PEAK = 0.05;
/** Below this content detail level (see textureLevel) frames are not aligned. */
const MIN_TEXTURE = 0.02;

function isRange(v: unknown): v is RawRange {
  return typeof v === 'object' && v !== null && 'min' in v && 'max' in v;
}

type Waiter = (s: FrameSample) => void;

export class Camera implements MeasureCamera {
  exposure: Range = { min: 0, max: 0, step: 0 };
  iso?: Range;
  caps: Caps = {};
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private waiters: Waiter[] = [];
  private loop = 0;
  private imageSet: Record<string, unknown> = {};
  private registrar: Registrar | null = null;
  private wantReference = false;
  /** Size of the channel grids (cells per channel row, rows). */
  grid?: { w: number; h: number };
  /** Cell weights computed from the alignment reference (see edgeWeights). */
  private weights?: Float32Array[];
  /** Fine-detail level of the screen content at the reference frame (see textureLevel). */
  texture?: number;

  private constructor(
    readonly video: HTMLVideoElement,
    readonly stream: MediaStream,
    readonly track: MediaStreamTrack,
    private readonly base: MediaTrackConstraints,
  ) {}

  static async open(video: HTMLVideoElement): Promise<Camera> {
    const base: MediaTrackConstraints = {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
    const stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
    const cam = new Camera(video, stream, stream.getVideoTracks()[0], base);
    video.srcObject = stream;
    await video.play();
    cam.startLoop();
    // Chrome on Android reports image-capture capabilities only once the camera runs.
    await cam.nextFrames(1, 3000);
    await new Promise((r) => setTimeout(r, 700));
    cam.readCaps();
    return cam;
  }

  readCaps() {
    this.caps = this.track.getCapabilities() as unknown as Caps;
    const e = this.caps.exposureTime;
    if (isRange(e)) {
      this.exposure = {
        min: e.min * EXPOSURE_UNIT,
        max: e.max * EXPOSURE_UNIT,
        step: (e.step && e.step > 0 ? e.step : 0) * EXPOSURE_UNIT,
      };
    }
    const iso = this.caps.iso;
    this.iso = isRange(iso) && iso.max > iso.min ? { min: iso.min, max: iso.max, step: iso.step && iso.step > 0 ? iso.step : 0 } : undefined;
  }

  get manualExposure(): boolean {
    const modes = this.caps.exposureMode;
    return Array.isArray(modes) && modes.includes('manual') && this.exposure.max > this.exposure.min;
  }

  settings(): Record<string, unknown> {
    return this.track.getSettings() as unknown as Record<string, unknown>;
  }

  private async apply(change: Record<string, unknown>) {
    this.imageSet = { ...this.imageSet, ...change };
    await this.track.applyConstraints({ ...this.base, advanced: [this.imageSet as MediaTrackConstraintSet] });
  }

  async setExposure(exposure: number, iso?: number): Promise<void> {
    // Chrome needs manual mode applied on its own before it accepts an exposure time.
    if (this.imageSet.exposureMode !== 'manual') await this.apply({ exposureMode: 'manual' });
    const change: Record<string, unknown> = { exposureTime: exposure / EXPOSURE_UNIT };
    if (iso !== undefined && this.iso) change.iso = iso;
    await this.apply(change);
  }

  /** The next analysed frame becomes the alignment reference for all later frames. */
  resetAlignment() {
    this.wantReference = true;
    this.registrar?.clear();
  }

  /** Back to automatic exposure for the preview. */
  async auto(): Promise<void> {
    this.registrar?.clear();
    const modes = this.caps.exposureMode;
    if (!Array.isArray(modes) || !modes.includes('continuous')) return;
    this.imageSet = {};
    await this.track.applyConstraints({ ...this.base, advanced: [{ exposureMode: 'continuous' } as MediaTrackConstraintSet] });
  }

  async capture(discard: number, count: number): Promise<FrameSample[]> {
    const frames = await this.nextFrames(discard + count, 10000);
    return frames.slice(discard);
  }

  /** Next n analysed frames, or fewer if timeoutMs passes first. */
  nextFrames(n: number, timeoutMs: number): Promise<FrameSample[]> {
    return new Promise((resolve) => {
      const out: FrameSample[] = [];
      const timer = setTimeout(() => resolve(out), timeoutMs);
      const take: Waiter = (s) => {
        out.push(s);
        if (out.length >= n) {
          clearTimeout(timer);
          resolve(out);
        } else this.waiters.push(take);
      };
      this.waiters.push(take);
    });
  }

  stop() {
    this.loop++;
    this.stream.getTracks().forEach((t) => t.stop());
  }

  /** Which clock the frame times come from (diagnostics): see frameTime(). */
  timeSource = '';

  /**
   * Frame capture time in seconds. The coherent analysis needs it accurate to well under a
   * millisecond: the camera's capture timestamp if Chrome provides it, else the stream's
   * media timestamp (also from the camera), else the callback time (display-paced).
   */
  private frameTime(now: number, meta: VideoFrameCallbackMetadata): number {
    if (meta.captureTime !== undefined && meta.captureTime > 0) {
      this.timeSource = 'captureTime';
      return meta.captureTime / 1000;
    }
    if (meta.mediaTime > 0) {
      this.timeSource = 'mediaTime';
      return meta.mediaTime;
    }
    this.timeSource = 'callback';
    return now / 1000;
  }

  private startLoop() {
    const token = ++this.loop;
    const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (token !== this.loop) return;
      if (this.waiters.length) {
        const sample = this.sample(this.frameTime(now, meta));
        if (sample) {
          const waiters = this.waiters;
          this.waiters = [];
          waiters.forEach((w) => w(sample));
        }
      }
      this.video.requestVideoFrameCallback(onFrame);
    };
    this.video.requestVideoFrameCallback(onFrame);
  }

  /**
   * Downscales the frame, aligns it to the reference (translation) and averages the
   * centred region into CELL x CELL cells. Even and odd cell columns become the two
   * channels. Bands may run at any angle, so no readout direction is assumed.
   */
  private sample(time: number): FrameSample | null {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = ANALYSIS_LONG / Math.max(vw, vh);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.registrar = null;
    }
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.video, 0, 0, w, h);
    const data = this.ctx.getImageData(0, 0, w, h).data;
    const luma = new Float32Array(w * h);
    const logLuma = new Float32Array(w * h);
    const clipped = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      const R = data[p];
      const G = data[p + 1];
      const B = data[p + 2];
      const l = 0.299 * R + 0.587 * G + 0.114 * B;
      luma[i] = l;
      logLuma[i] = Math.log(l > 1 ? l : 1);
      clipped[i] = R >= 250 || G >= 250 || B >= 250 ? 1 : 0;
    }

    this.registrar ??= new Registrar(w, h);
    let dx = 0;
    let dy = 0;
    let aligned = true;
    let newReference = false;
    if (this.wantReference || !this.registrar.hasReference) {
      this.registrar.setReference(logLuma);
      newReference = this.wantReference;
      if (!this.wantReference) this.weights = undefined;
      this.wantReference = false;
    } else if ((this.texture ?? 1) >= MIN_TEXTURE) {
      const s = this.registrar.estimate(logLuma);
      dx = s.dx;
      dy = s.dy;
      aligned = s.peak >= MIN_PEAK;
    }
    // A plain screen has no detail to align on: the alignment would lock onto the flicker
    // bands instead and cancel their real movement. Without detail, small hand movements
    // leave no residue anyway, so such measurements are not aligned.

    // Region in reference coordinates; sampled from this frame at (x + dx, y + dy).
    const gw = Math.floor((w * REGION) / CELL) & ~1;
    const gh = Math.floor((h * REGION) / CELL);
    const x0 = (w - gw * CELL) / 2;
    const y0 = (h - gh * CELL) / 2;
    const half = gw >> 1;
    this.grid = { w: half, h: gh };
    if (newReference) {
      this.weights = edgeWeights(logLuma, w, x0, y0, gw, gh);
      this.texture = textureLevel(logLuma, w, h);
    }
    const a = new Float32Array(gh * half);
    const b = new Float32Array(gh * half);
    let sum = 0;
    let clip = 0;
    let n = 0;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let acc = 0;
        for (let cy = 0; cy < CELL; cy++) {
          for (let cx = 0; cx < CELL; cx++) {
            const x = x0 + gx * CELL + cx + dx;
            const y = y0 + gy * CELL + cy + dy;
            const v = bilinear(luma, w, h, x, y);
            if (Number.isNaN(v)) {
              aligned = false;
              continue;
            }
            acc += v;
            clip += clipped[Math.round(y) * w + Math.round(x)];
            n++;
          }
        }
        const cell = acc / (CELL * CELL);
        (gx % 2 ? b : a)[gy * half + (gx >> 1)] = cell;
        sum += acc;
      }
    }
    return { channels: [a, b], weights: this.weights, meanLuma: n ? sum / n : 0, clipFraction: n ? clip / n : 1, time, shift: [dx, dy], aligned };
  }
}

/**
 * Fine detail in the centre of a log-luma image: RMS of the image minus its 5 x 5 box blur.
 * Text and UI give values well above sensor noise; a plain screen gives about the noise.
 */
function textureLevel(logLuma: Float32Array, w: number, h: number): number {
  const x0 = Math.floor(w * 0.2);
  const x1 = Math.floor(w * 0.8);
  const y0 = Math.floor(h * 0.2);
  const y1 = Math.floor(h * 0.8);
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let b = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) b += logLuma[(y + dy) * w + x + dx];
      const d = logLuma[y * w + x] - b / 25;
      s += d * d;
      n++;
    }
  }
  return n ? Math.sqrt(s / n) : 0;
}

/**
 * Cell weights from the reference frame: 1 / (1 + v / median v)^2 with v the log-luma
 * variance inside the cell. Sharp content edges (text) are where sub-pixel alignment
 * errors leave residue between exposure steps; flicker bands are smooth and present in
 * every cell. On real recordings this lowered the residue ~8x for ~30% less band signal.
 */
function edgeWeights(logLuma: Float32Array, w: number, x0: number, y0: number, gw: number, gh: number): Float32Array[] {
  const half = gw >> 1;
  const v = new Float64Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let s = 0;
      let s2 = 0;
      for (let cy = 0; cy < CELL; cy++) {
        for (let cx = 0; cx < CELL; cx++) {
          const val = logLuma[Math.round(y0 + gy * CELL + cy) * w + Math.round(x0 + gx * CELL + cx)];
          s += val;
          s2 += val * val;
        }
      }
      const m = s / (CELL * CELL);
      v[gy * gw + gx] = Math.max(0, s2 / (CELL * CELL) - m * m);
    }
  }
  const sorted = [...v].sort((p, q) => p - q);
  const med = Math.max(sorted[sorted.length >> 1], 1e-6);
  const wa = new Float32Array(gh * half);
  const wb = new Float32Array(gh * half);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const wt = 1 / (1 + v[gy * gw + gx] / med) ** 2;
      (gx % 2 ? wb : wa)[gy * half + (gx >> 1)] = wt;
    }
  }
  return [wa, wb];
}
