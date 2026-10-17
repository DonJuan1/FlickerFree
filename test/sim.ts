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
  rows?: number;
  strips?: number;
  /** Time to read out all rows (s). */
  readout?: number;
  /** Phone frame rate; frame start times advance by 1/fps. */
  cameraFps?: number;
  /** Profile noise (luma units, after averaging). */
  noise?: number;
  /** Content: 'flat', 'smooth' (different per strip) or 'edges' (adds full-width structures). */
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
  const rows = opt.rows ?? 360;
  const strips = opt.strips ?? 4;
  const readout = opt.readout ?? 0.025;
  const fps = opt.cameraFps ?? 30.02;
  const noise = opt.noise ?? 0.15;
  const r = rng((opt.seed ?? 1) * 7919 + frame0 * 104729 + Math.round(e * 1e7));
  const content = buildContent(opt.content ?? 'smooth', strips, rows, opt.seed ?? 1);
  const out: FrameSample[] = [];
  for (let k = 0; k < count; k++) {
    const tFrame = (frame0 + k) / fps;
    const band = new Float64Array(rows);
    for (let y = 0; y < rows; y++) {
      const t = tFrame + (y / rows) * readout;
      let v = 1;
      for (const s of opt.sources) v += windowAverage(s, t, e) - 1;
      band[y] = v;
    }
    let sum = 0;
    let clip = 0;
    const profiles = content.map((c) => {
      const p = new Float32Array(rows);
      for (let y = 0; y < rows; y++) {
        // Display gamma on top of linear light; the exposure itself is ISO-compensated.
        const lum = 255 * Math.pow(Math.min(1, Math.max(0, 0.4 * c[y] * band[y])), 1 / 2.2) + noise * gauss(r);
        p[y] = lum;
        sum += lum;
        if (lum >= 250) clip++;
      }
      return p;
    });
    out.push({ strips: profiles, meanLuma: sum / (rows * strips), clipFraction: clip / (rows * strips), time: tFrame });
  }
  return out;
}

function buildContent(kind: 'flat' | 'smooth' | 'edges', strips: number, rows: number, seed: number): Float64Array[] {
  const r = rng(seed * 31337 + 1);
  const common = new Float64Array(rows);
  if (kind === 'edges') {
    // Full-width structures (e.g. a taskbar, letterbox bars) look the same in every strip.
    for (let y = 0; y < rows; y++) common[y] = y > rows * 0.85 ? -0.35 : y < rows * 0.1 ? -0.2 : 0;
  }
  return Array.from({ length: strips }, () => {
    const c = new Float64Array(rows);
    const waves = kind === 'flat' ? [] : Array.from({ length: 6 }, () => ({ a: 0.15 * r(), k: 1 + 25 * r(), p: r() * 6.28 }));
    for (let y = 0; y < rows; y++) {
      let v = 1 + common[y];
      for (const w of waves) v += w.a * Math.sin((w.k * 2 * Math.PI * y) / rows + w.p);
      c[y] = Math.max(0.05, v);
    }
    return c;
  });
}
