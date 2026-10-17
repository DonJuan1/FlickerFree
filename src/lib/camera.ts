// Browser camera wrapper: opens the back camera, exposes manual exposure/ISO control
// (Chrome on Android, Image Capture constraints) and turns frames into FrameSamples.

import type { FrameSample } from './analysis';
import type { MeasureCamera, Range } from './measure';

type Caps = Record<string, unknown>;
type RawRange = { min: number; max: number; step?: number };

/** Strips across the long axis; their profiles run along the sensor readout axis. */
const STRIPS = 4;
/** Max samples along the readout axis. */
const READOUT_SAMPLES = 480;
/** Samples along the long axis (averaged into strips). */
const LONG_SAMPLES = 128;
/** Analysed part of each axis: the readout axis minus 5% margins, the middle 60% of the long axis. */
export const REGION = { readout: 0.9, long: 0.6 };
/** exposureTime constraint unit: 100 microseconds. */
const EXPOSURE_UNIT = 1e-4;

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

  /** Back to automatic exposure for the preview. */
  async auto(): Promise<void> {
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

  private startLoop() {
    const token = ++this.loop;
    const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (token !== this.loop) return;
      if (this.waiters.length) {
        const sample = this.sample((meta.captureTime ?? now) / 1000);
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
   * Strip profiles along the sensor readout axis. Phone sensors are landscape and read out
   * row by row across the short side, so the readout axis is the frame's short side, also
   * when the browser delivers rotated portrait frames.
   */
  private sample(time: number): FrameSample | null {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const alongY = vw >= vh;
    const rows = Math.min(READOUT_SAMPLES, alongY ? vh : vw);
    const cw = alongY ? LONG_SAMPLES : rows;
    const ch = alongY ? rows : LONG_SAMPLES;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.video, 0, 0, cw, ch);
    const data = this.ctx.getImageData(0, 0, cw, ch).data;

    const r0 = Math.floor((rows * (1 - REGION.readout)) / 2);
    const r1 = rows - r0;
    const l0 = Math.floor((LONG_SAMPLES * (1 - REGION.long)) / 2);
    const stripWidth = Math.floor((LONG_SAMPLES - 2 * l0) / STRIPS);
    const strips = Array.from({ length: STRIPS }, () => new Float32Array(r1 - r0));
    let sum = 0;
    let clip = 0;
    for (let r = r0; r < r1; r++) {
      for (let s = 0; s < STRIPS; s++) {
        let acc = 0;
        for (let l = l0 + s * stripWidth; l < l0 + (s + 1) * stripWidth; l++) {
          const i = (alongY ? r * cw + l : l * cw + r) * 4;
          const R = data[i];
          const G = data[i + 1];
          const B = data[i + 2];
          acc += 0.299 * R + 0.587 * G + 0.114 * B;
          if (R >= 250 || G >= 250 || B >= 250) clip++;
        }
        strips[s][r - r0] = acc / stripWidth;
        sum += acc;
      }
    }
    const n = (r1 - r0) * STRIPS * stripWidth;
    return { strips, meanLuma: sum / n, clipFraction: clip / n, time };
  }
}
