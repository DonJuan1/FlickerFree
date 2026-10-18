// Rolling-shutter flicker simulator for tests. Produces the same FrameSample data the
// camera pipeline produces, from a model of the screen's light output over time.

import type { FrameSample } from '../src/lib/analysis';

export interface Source {
  /** Flicker frequency in Hz. */
  f: number;
  /** Modulation depth (0..1) around the mean. */
  depth: number;
  /** PWM duty cycle; omitted = sinusoidal. */
  duty?: number;
  /** Phase offset in cycles. */
  phase?: number;
}

export interface SimOptions {
  sources: Source[];
  /** Grid cells along the camera's readout axis. */
  rows?: number;
  /** Grid cells across it (even/odd columns become channels A/B). */
  cols?: number;
  /** Time for the camera to read out the analysed rows (s). */
  readout?: number;
  /**
   * Time for the screen to scan across the analysed columns (s); 0 = all screen rows
   * flicker in phase. Non-zero tilts the bands, as with OLED screens scanning their rows
   * perpendicular to the camera's readout.
   */
  scan?: number;
  /** Phone frame rate; frame start times advance by 1/fps. */
  cameraFps?: number;
  /** Error (s, standard deviation) of the reported frame times. */
  timeJitter?: number;
  /** Per-cell noise (luma units). */
  noise?: number;
  /** Screen content: 'flat', 'smooth' (2D waves) or 'edges' (text-like rows and boxes). */
  content?: 'flat' | 'smooth' | 'edges';
  seed?: number;
}

/** Mean of a source's normalised light output (mean 1) over [t - e, t]. */
function windowAverage(s: Source, t: number, e: number): number {
  const ph = s.phase ?? 0;
  if (s.duty === undefined) {
    const w = 2 * Math.PI * s.f;
    const c = (Math.cos(w * (t - e) + 2 * Math.PI * ph) - Math.cos(w * t + 2 * Math.PI * ph)) / (w * e);
    return 1 + s.depth * c;
  }
  // PWM: on for duty of each period. cum(t) = time spent on in [0, t].
  const d = s.duty;
  const p = 1 / s.f;
  const cum = (x: number) => {
    const y = x + ph * p;
    const k = Math.floor(y / p);
    return k * d * p + Math.min(y - k * p, d * p);
  };
  const on = (cum(t) - cum(t - e)) / e; // fraction of the window lit, mean = d
  return 1 + s.depth * (on / d - 1);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Simulates `count` frames at exposure e (seconds), starting at frame index `frame0`. */
export function simulateFrames(opt: SimOptions, e: number, count: number, frame0 = 0): FrameSample[] {
  const rows = opt.rows ?? 48;
  const cols = opt.cols ?? 32;
  const readout = opt.readout ?? 0.025;
  const scan = opt.scan ?? 0;
  const fps = opt.cameraFps ?? 30.02;
  const noise = opt.noise ?? 0.15;
  const r = rng((opt.seed ?? 1) * 7919 + frame0 * 104729 + Math.round(e * 1e7));
  const content = buildContent(opt.content ?? 'smooth', rows, cols, opt.seed ?? 1);
  const out: FrameSample[] = [];
  for (let k = 0; k < count; k++) {
    const tFrame = (frame0 + k) / fps;
    const half = cols >> 1;
    const a = new Float32Array(rows * half);
    const b = new Float32Array(rows * half);
    let sum = 0;
    let clip = 0;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < half * 2; x++) {
        const t = tFrame + (y / rows) * readout - (x / cols) * scan;
        let band = 1;
        for (const s of opt.sources) band += windowAverage(s, t, e) - 1;
        // Display gamma on top of linear light; the exposure itself is ISO-compensated.
        const lum = 255 * Math.pow(Math.min(1, Math.max(0, 0.4 * content[y * cols + x] * band)), 1 / 2.2) + noise * gauss(r);
        (x % 2 ? b : a)[y * half + (x >> 1)] = lum;
        sum += lum;
        if (lum >= 250) clip++;
      }
    }
    const n = rows * half * 2;
    const reported = tFrame + (opt.timeJitter ?? 0) * gauss(r);
    out.push({ channels: [a, b], meanLuma: sum / n, clipFraction: clip / n, time: reported });
  }
  return out;
}

function buildContent(kind: 'flat' | 'smooth' | 'edges', rows: number, cols: number, seed: number): Float64Array {
  const r = rng(seed * 31337 + 1);
  const c = new Float64Array(rows * cols).fill(1);
  if (kind === 'flat') return c;
  const waves = Array.from({ length: 8 }, () => ({ a: 0.12 * r(), ky: 1 + 12 * r(), kx: 12 * r() - 6, p: r() * 6.28 }));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let v = 1;
      for (const w of waves) v += w.a * Math.sin(2 * Math.PI * ((w.ky * y) / rows + (w.kx * x) / cols) + w.p);
      c[y * cols + x] = v;
    }
  }
  if (kind === 'edges') {
    // Text-like structure: dark rows of glyph boxes and a bar along one edge.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x > cols * 0.88) c[y * cols + x] *= 0.4;
        else if (y % 6 === 2 && r() < 0.6) c[y * cols + x] *= 0.35;
      }
    }
  }
  for (let i = 0; i < c.length; i++) c[i] = Math.max(0.05, c[i]);
  return c;
}
