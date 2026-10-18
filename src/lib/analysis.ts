// Pure analysis: per-step band profiles, content-free distances between exposure steps,
// flicker-frequency fit across a sweep, clean shutter values and refinement helpers.
// No DOM or camera dependencies.
//
// Physics: a rolling-shutter row integrates the screen's light over the exposure E.
// Banding vanishes when E is a whole number of flicker periods: E = n / f. That holds
// for any camera, so a clean value measured on the phone is clean on a cinema camera too.
//
// Screen content is the same at every exposure step (ISO keeps the brightness constant,
// frames are aligned against hand shake) while the bands change, so steps are compared
// with each other: in log brightness the content cancels in the difference between two
// steps. Frames are 2D grids, so bands may run at any angle (screens that scan their rows
// tilt them). Covariance between interleaved halves of the grid removes sensor noise.

/** One analysed frame. */
export interface FrameSample {
  /**
   * Interleaved halves of the frame's luma grid (e.g. even and odd cell columns), equal
   * length. Bands and content are nearly identical in both, sensor noise independent, so
   * their cross products measure band energy without a noise bias.
   */
  channels: Float32Array[];
  meanLuma: number;
  /** Fraction of analysed pixels at or near full white. */
  clipFraction: number;
  /** Capture time in seconds (any fixed origin). */
  time: number;
  /**
   * Per-element weights for the channels (same for every frame of a measurement): cells
   * with sharp content edges, where alignment leaves residue, count less. Default 1.
   */
  weights?: Float32Array[];
  /** Alignment offset against the reference frame, in analysis pixels. */
  shift?: [number, number];
  /** False if alignment failed or the region left the frame; such frames are not used. */
  aligned?: boolean;
}

/** Summary of one exposure step, see stepProfile(). */
export interface StepProfile {
  exposure: number;
  /** Mean over frames of the cross-channel covariance of each frame's log profiles. */
  selfCov: number;
  /** Per channel: mean over frames of the log profiles. */
  mean: Float64Array[];
  /** Capture times of the frames, seconds. */
  times: number[];
}

export interface FlickerFit {
  frequency: number;
  /** Other well-scoring frequencies (local maxima of the score), best first. */
  candidates?: number[];
  /** Mean dip contrast (antinode - null) / antinode: 1 = perfectly clean dips, <= 0 = no evidence. */
  confidence: number;
  /** Predicted null exposures inside the sweep that supported the fit. */
  anchors: number[];
  /** RMS band strength (log brightness) halfway between nulls. */
  amplitude: number;
  /** Noise floor (RMS, log brightness): the scatter of distance estimates within a step. */
  floor: number;
  /** Diagnostics: summed log null depth, mean null energy, distance noise, number of nulls. */
  stats?: { score: number; nullEnergy: number; selfNoise: number; nulls: number };
}

/** Below this RMS band strength (log luma) flicker counts as absent, whatever the noise floor. */
export const MIN_FLICKER_AMPLITUDE = 0.0004;
/** Residual level (log luma) separating clean from flickering nulls in the sub-harmonic check. */
const SUBHARMONIC_LEVEL = 0.0015;
/**
 * Band strength must also be this many times the noise floor (RMS ratio; 2.5 = energy
 * ratio ~6). In simulation real flicker scores >= 3 (energy >= 9), steady screens <= 1.7.
 */
export const MIN_SIGNAL_TO_FLOOR = 2.5;
/** Minimum mean dip contrast for a sub-harmonic to replace the best fit. */
export const MIN_CONFIDENCE = 0.5;

/** Log luma minus its mean (the mean absorbs global brightness differences between steps). */
export function logProfile(p: ArrayLike<number>): Float64Array {
  const n = p.length;
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.log(p[i] > 1 ? p[i] : 1);
    sum += out[i];
  }
  const mean = n ? sum / n : 0;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

/** sqrt(w) * (x - weighted mean of x); x unchanged without weights. */
function weighted(x: Float64Array, w: Float32Array | undefined): Float64Array {
  if (!w) return x;
  let sw = 0;
  let swx = 0;
  for (let i = 0; i < x.length; i++) {
    sw += w[i];
    swx += w[i] * x[i];
  }
  const mean = sw > 0 ? swx / sw : 0;
  for (let i = 0; i < x.length; i++) x[i] = Math.sqrt(w[i]) * (x[i] - mean);
  return x;
}

/** Mean over channel pairs a < b of the symmetrised dot product <x_a, y_b>, per element. */
function crossCov(x: Float64Array[], y: Float64Array[]): number {
  let acc = 0;
  let pairs = 0;
  for (let a = 0; a < x.length; a++) {
    for (let b = a + 1; b < x.length; b++) {
      acc += (dot(x[a], y[b]) + dot(x[b], y[a])) / 2;
      pairs++;
    }
  }
  return pairs ? acc / pairs / x[0].length : 0;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function stepProfile(exposure: number, frames: FrameSample[]): StepProfile {
  const k = frames[0]?.channels.length ?? 0;
  const rows = frames[0]?.channels[0]?.length ?? 0;
  const mean = Array.from({ length: k }, () => new Float64Array(rows));
  let selfCov = 0;
  for (const f of frames) {
    const logs = f.channels.map((c, k) => weighted(logProfile(c), f.weights?.[k]));
    selfCov += crossCov(logs, logs);
    logs.forEach((l, s) => {
      for (let i = 0; i < rows; i++) mean[s][i] += l[i] / frames.length;
    });
  }
  return { exposure, selfCov: frames.length ? selfCov / frames.length : 0, mean, times: frames.map((f) => f.time) };
}

/**
 * Squared band distance between two steps, averaged over their frame pairs. Content
 * shared by both steps cancels; rolling bands count with their full per-frame energy.
 */
export function profileDistance(a: StepProfile, b: StepProfile): number {
  return a.selfCov + b.selfCov - 2 * crossCov(a.mean, b.mean);
}

/** Flicker energy of a single step on its own (content not removed). For live display. */
export function flickerEnergy(frames: FrameSample[]): number {
  return stepProfile(0, frames).selfCov;
}

/** All steps of a sweep with their pairwise distances, interpolated in log exposure. */
export class SweepModel {
  readonly steps: StepProfile[];
  private readonly xs: number[];
  private readonly D: Float64Array;
  /** Gram matrix of the step means (cross-channel): G[i][j] = crossCov(mean_i, mean_j). */
  readonly G: Float64Array;

  constructor(steps: StepProfile[]) {
    this.steps = [...steps].sort((a, b) => a.exposure - b.exposure);
    this.xs = this.steps.map((s) => Math.log(s.exposure));
    const n = this.steps.length;
    this.D = new Float64Array(n * n);
    this.G = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const g = crossCov(this.steps[i].mean, this.steps[j].mean);
        const d = this.steps[i].selfCov + this.steps[j].selfCov - 2 * g;
        this.G[i * n + j] = this.G[j * n + i] = g;
        this.D[i * n + j] = this.D[j * n + i] = d;
      }
    }
  }

  /**
   * Band energy of a step against a content estimate given as weights over the sweep's
   * step means (content = sum w_i mean_i), averaged over the step's frames.
   */
  energyVsContent(step: StepProfile, weights: Float64Array): number {
    const n = this.steps.length;
    let cross = 0;
    for (let i = 0; i < n; i++) if (weights[i]) cross += weights[i] * crossCov(step.mean, this.steps[i].mean);
    return step.selfCov + this.contentNorm(weights) - 2 * cross;
  }

  /** Band energy of sweep step i against the content estimate. */
  stepEnergyVsContent(i: number, weights: Float64Array): number {
    const n = this.steps.length;
    let cross = 0;
    for (let j = 0; j < n; j++) cross += weights[j] * this.G[i * n + j];
    return this.steps[i].selfCov + this.contentNorm(weights) - 2 * cross;
  }

  private contentNorm(w: Float64Array): number {
    const n = this.steps.length;
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      for (let j = 0; j < n; j++) s += w[i] * w[j] * this.G[i * n + j];
    }
    return s;
  }

  get eMin() {
    return this.steps[0].exposure;
  }

  get eMax() {
    return this.steps[this.steps.length - 1].exposure;
  }

  /** Median spacing between steps in log exposure. */
  get logSpacing(): number {
    return median(this.xs.slice(1).map((x, i) => x - this.xs[i]));
  }

  get maxDistance(): number {
    return Math.max(...this.D);
  }

  /**
   * Noise level of a distance estimate. Self-distances D_ii (frame-to-frame variation
   * within a step) are unbiased by sensor noise, so their magnitude at the quietest steps
   * (5th percentile of |D_ii|, median of three neighbours) shows how much estimates
   * scatter. Rolling bands inflate D_ii at every step except near the nulls, which is why
   * only the quietest few count.
   */
  get selfNoise(): number {
    const n = this.steps.length;
    const self = this.steps.map((_, i) => Math.abs(this.D[i * n + i]));
    const smooth = self.map((_, i) => median(self.slice(Math.max(0, i - 1), i + 2))).sort((a, b) => a - b);
    return smooth[Math.floor(0.05 * (smooth.length - 1))] ?? 0;
  }

  /** Index i and weight t so that log e = (1 - t) xs[i] + t xs[i + 1], or null outside the sweep. */
  private locate(e: number): { i: number; t: number } | null {
    const x = Math.log(e);
    const xs = this.xs;
    if (x < xs[0] - 1e-6 || x > xs[xs.length - 1] + 1e-6) return null;
    if (xs.length === 1) return { i: 0, t: 0 };
    let i = 0;
    while (i < xs.length - 2 && xs[i + 1] < x) i++;
    return { i, t: Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i]))) };
  }

  /** Distance from step j to the point between steps i and i + 1 (law of cosines). */
  private toStep(j: number, p: { i: number; t: number }): number {
    const n = this.steps.length;
    const { i, t } = p;
    if (t === 0) return this.D[i * n + j];
    return (1 - t) * this.D[i * n + j] + t * this.D[(i + 1) * n + j] - t * (1 - t) * this.D[i * n + i + 1];
  }

  /** Squared band distance between two exposures inside the sweep (NaN outside). */
  dist(ea: number, eb: number): number {
    const a = this.locate(ea);
    const b = this.locate(eb);
    if (!a || !b) return NaN;
    const n = this.steps.length;
    const at = (j: number) => this.toStep(j, b);
    if (a.t === 0) return at(a.i);
    return (1 - a.t) * at(a.i) + a.t * at(a.i + 1) - a.t * (1 - a.t) * this.D[a.i * n + a.i + 1];
  }

  /** Spread term for centroid distances: (1 / 2N^2) * sum of pairwise distances of the anchors. */
  private spread(anchors: number[]): number {
    let s = 0;
    for (const a of anchors) for (const b of anchors) s += this.dist(a, b);
    return s / (2 * anchors.length * anchors.length);
  }

  /** Band energy at e: squared distance to the centroid of the anchors (the predicted nulls). */
  energyAt(e: number, anchors: number[], spread = this.spread(anchors)): number {
    let s = 0;
    for (const a of anchors) s += this.dist(e, a);
    return s / anchors.length - spread;
  }

  /**
   * Weights over the step means whose combination is the centroid of the given exposures
   * (each a linear interpolation between its neighbouring steps in log exposure).
   */
  anchorWeights(anchors: number[]): Float64Array {
    const w = new Float64Array(this.steps.length);
    let n = 0;
    for (const a of anchors) {
      const p = this.locate(a);
      if (!p) continue;
      w[p.i] += 1 - p.t;
      if (p.t > 0) w[p.i + 1] += p.t;
      n++;
    }
    if (n) for (let i = 0; i < w.length; i++) w[i] /= n;
    return w;
  }

}

interface Candidate {
  f: number;
  score: number;
  contrast: number;
  anchors: number[];
  /** Mean antinode energy. */
  anti: number;
  /** Mean magnitude of the energy at the nulls (scatter around zero for clean nulls). */
  nullEnergy: number;
  /** Null orders n (exposure n / f) that had antinodes to compare with. */
  nulls: { n: number }[];
}

function evaluate(model: SweepModel, f: number, nMax: number, eps: number): Candidate | null {
  const { eMin, eMax } = model;
  const nFrom = Math.max(1, Math.ceil(f * eMin * (1 - 1e-7)));
  const nTo = Math.min(nMax, Math.floor(f * eMax * (1 + 1e-7)));
  if (nTo - nFrom < 1) return null; // needs at least two nulls to compare
  const anchors: number[] = [];
  for (let n = nFrom; n <= nTo; n++) anchors.push(n / f);
  let spread = 0;
  for (const a of anchors) for (const b of anchors) spread += model.dist(a, b);
  spread /= 2 * anchors.length * anchors.length;
  let score = 0;
  let contrast = 0;
  let antiSum = 0;
  let nullSum = 0;
  let count = 0;
  const nulls: Candidate['nulls'] = [];
  for (let n = nFrom; n <= nTo; n++) {
    const antis = [(n - 0.5) / f, (n + 0.5) / f].filter((e) => e >= eMin * (1 - 1e-7) && e <= eMax * (1 + 1e-7));
    if (!antis.length) continue;
    const a = antis.reduce((s, e) => s + model.energyAt(e, anchors, spread), 0) / antis.length;
    const v = model.energyAt(n / f, anchors, spread);
    // Log depth ratio rewards deep nulls. The floor caps it at 1e5:1, or lower where camera
    // noise sets the limit, so a single freak value can't dominate.
    const floor = Math.max(1e-5 * Math.max(a, 0), eps);
    score += Math.log((Math.max(a, 0) + floor) / (Math.max(v, 0) + floor));
    contrast += (a - v) / (Math.max(a, 0) + floor);
    antiSum += a;
    nullSum += Math.abs(v);
    nulls.push({ n });
    count++;
  }
  if (!count || !Number.isFinite(score)) return null;
  return { f, score, contrast: contrast / count, anchors, anti: antiSum / count, nullEnergy: nullSum / count, nulls };
}

/**
 * Mean dip contrast of the nulls predicted for frequency f (see fitFlicker): near 1 when
 * the sweep's steps at n / f are clean compared with those halfway between, ~0 when not.
 */
export function nullContrast(model: SweepModel, f: number): number {
  const dLog = model.logSpacing;
  const nMax = Math.max(2, Math.floor(1 / (4 * dLog)));
  const c = evaluate(model, f, nMax, Math.max(model.selfNoise, 1e-12));
  return c ? c.contrast : 0;
}

/**
 * Finds the flicker frequency f whose nulls (n / f) best explain the sweep. A candidate
 * scores when the steps at its predicted nulls look alike (bands gone, only content left)
 * and the steps halfway between them ((n +- 0.5) / f) look different. Log depth ratios are
 * summed over the nulls, which rewards explaining more dips: that separates f from its
 * sub-harmonics, while harmonics put nulls on antinodes and lose.
 */
export function fitFlicker(model: SweepModel): FlickerFit | null {
  if (model.steps.length < 6) return null;
  const { eMin, eMax } = model;
  const dLog = model.logSpacing;
  if (!(dLog > 0)) return null;
  // Nulls closer together than ~4 steps (spacing in log exposure ~ 1/n) can't be resolved.
  const nMax = Math.max(2, Math.floor(1 / (4 * dLog)));
  // Noise level of a distance: nulls can't be resolved below it.
  const eps = Math.max(model.selfNoise, 1e-12);
  const fLo = 1 / eMax;
  const fHi = nMax / eMin;
  if (!(fHi > fLo)) return null;

  const STEP = 0.0005;
  let best: Candidate | null = null;
  const scores: { f: number; score: number }[] = [];
  for (let lf = Math.log(fLo); lf <= Math.log(fHi); lf += STEP) {
    const c = evaluate(model, Math.exp(lf), nMax, eps);
    scores.push({ f: Math.exp(lf), score: c ? c.score : -Infinity });
    if (c && (!best || c.score > best.score)) best = c;
  }
  if (!best) return null;
  // Local maxima of the score, at least 3% apart, best first.
  const peaks = scores
    .filter((p, i) => Number.isFinite(p.score) && p.score >= (scores[i - 1]?.score ?? -Infinity) && p.score >= (scores[i + 1]?.score ?? -Infinity))
    .sort((a, b) => b.score - a.score);
  const candidates: number[] = [];
  for (const p of peaks) {
    if (candidates.length >= 6) break;
    if (candidates.every((c) => Math.abs(Math.log(p.f / c)) > 0.03)) candidates.push(p.f);
  }

  // Two flicker sources (e.g. PWM at 240 Hz plus a 60 Hz refresh scan): the PWM dips
  // dominate the score, but only every k-th of them is fully clean. If the nulls shared
  // with a sub-harmonic f / k are much cleaner than the others, the sub-harmonic is the
  // real answer, provided it fits well on its own.
  let chosen = best;
  let cleanest = Infinity;
  for (let k = 2; k <= 8; k++) {
    const shared = best.nulls.filter((x) => x.n % k === 0).map((x) => x.n / best.f);
    const other = best.nulls.filter((x) => x.n % k !== 0).map((x) => x.n / best.f);
    if (shared.length < 2 || !other.length) continue;
    // Energies against the centroid of the shared nulls: if those are clean it is the content.
    const vShared = mean(shared.map((e) => model.energyAt(e, shared)));
    const vOther = median(other.map((e) => model.energyAt(e, shared)));
    // Shared nulls must be clean in absolute terms, and the others must show a clearly
    // visible residual well above that (not just grid interpolation error).
    if (Math.sqrt(Math.max(0, vShared)) > SUBHARMONIC_LEVEL) continue;
    if (vOther < 10 * Math.max(vShared, eps) || Math.sqrt(vOther) < 2 * SUBHARMONIC_LEVEL) continue;
    if (vShared >= cleanest) continue;
    let sub: Candidate | null = null;
    const center = Math.log(best.f / k);
    for (let lf = center - 0.004; lf <= center + 0.004; lf += STEP) {
      const c = evaluate(model, Math.exp(lf), nMax, eps);
      if (c && (!sub || c.score > sub.score)) sub = c;
    }
    if (sub && sub.contrast >= MIN_CONFIDENCE) {
      chosen = sub;
      cleanest = vShared;
    }
  }
  const polished = polishAnchors(model, chosen.anchors, chosen.f);
  return {
    frequency: polished.f,
    candidates,
    confidence: chosen.contrast,
    anchors: polished.anchors,
    amplitude: Math.sqrt(Math.max(0, chosen.anti)),
    floor: Math.sqrt(eps),
    stats: {
      score: chosen.score,
      nullEnergy: chosen.nullEnergy,
      selfNoise: eps,
      nulls: chosen.nulls.length,
    },
  };
}

/**
 * Moves each predicted null to where the sweep's profiles match the other nulls best
 * (sub-step, via interpolation), then refits f = n / E by least squares. The grid search
 * lands within a percent or two; this pulls the nulls onto the data.
 */
function polishAnchors(model: SweepModel, anchors: number[], f: number): { f: number; anchors: number[] } {
  if (anchors.length < 2) return { f, anchors };
  const orders = anchors.map((a) => Math.round(a * f));
  const a = [...anchors];
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < a.length; i++) {
      const others = a.filter((_, j) => j !== i);
      const w = Math.min(0.05, 0.25 / orders[i]);
      let bestE = a[i];
      let bestD = Infinity;
      for (let k = -20; k <= 20; k++) {
        const e = a[i] * (1 + (w * k) / 20);
        if (e < model.eMin || e > model.eMax) continue;
        // Band amplitude falls as 1/exposure; weighting by exposure^2 keeps the dip
        // symmetric so its sampled minimum isn't pulled towards longer exposures.
        let d = 0;
        for (const o of others) d += model.dist(e, o);
        d *= (e / a[i]) ** 2;
        if (d < bestD) {
          bestD = d;
          bestE = e;
        }
      }
      a[i] = bestE;
    }
  }
  // Least squares for a_n = n * T.
  let num = 0;
  let den = 0;
  orders.forEach((n, i) => {
    num += n * a[i];
    den += n * n;
  });
  const fitted = den / num;
  // Keep the grid result if polishing wandered off (e.g. noise-dominated nulls).
  if (!(Math.abs(fitted / f - 1) < 0.03)) return { f, anchors };
  return { f: fitted, anchors: a };
}

export function gramOf(X: number[][]): number[][] {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const row of X) for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) A[a][b] += row[a] * row[b];
  return A;
}

/** Gauss-Jordan inverse with partial pivoting; null if singular. */
export function invert(M: number[][]): number[][] | null {
  const p = M.length;
  const a = M.map((row, i) => [...row, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (Math.abs(a[piv][c]) < 1e-14) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 2 * p; k++) a[c][k] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const m = a[r][c];
      if (m) for (let k = 0; k < 2 * p; k++) a[r][k] -= m * a[c][k];
    }
  }
  return a.map((row) => row.slice(p));
}

export function isFlicker(fit: FlickerFit | null): fit is FlickerFit {
  return !!fit && fit.amplitude >= MIN_FLICKER_AMPLITUDE && fit.amplitude >= MIN_SIGNAL_TO_FLOOR * fit.floor;
}

/** Exposure values from eMin to eMax with a constant ratio, snapped to the device step. */
export function exposureGrid(eMin: number, eMax: number, ratio: number, step = 0): number[] {
  const out: number[] = [];
  for (let e = eMin; e <= eMax * (1 + 1e-9); e *= ratio) out.push(snapExposure(e, step));
  if (out[out.length - 1] < eMax * (1 - 1e-9)) out.push(snapExposure(eMax, step));
  return [...new Set(out)].filter((e) => e >= eMin * (1 - 1e-9) && e <= eMax * (1 + 1e-9) && e > 0);
}

export function snapExposure(e: number, step: number): number {
  return step > 0 ? Math.max(step, Math.round(e / step) * step) : e;
}

/**
 * All clean exposures n / f within [eMin, eMax]. A value up to 0.5% past eMax (e.g. 1/49.9
 * at 50 fps) is kept and clamped to eMax: the residual there is negligible.
 */
export function cleanExposures(f: number, eMin: number, eMax: number): number[] {
  const out: number[] = [];
  for (let n = Math.max(1, Math.ceil(f * eMin * (1 - 1e-9))); n / f <= eMax * 1.005; n++) out.push(Math.min(n / f, eMax));
  return out;
}

/** The value closest to target on a log scale (equal ratio either side). */
export function closestTo(values: number[], target: number): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    if (best === undefined || Math.abs(Math.log(v / target)) < Math.abs(Math.log(best / target))) best = v;
  }
  return best;
}

export interface NullFit {
  /** Position of the null. */
  x0: number;
  /** Slope factor and shape exponent: y = a |x - x0|^p + b. */
  a: number;
  p: number;
  /** Level at the bottom: ~0 when the content reference is clean. */
  b: number;
}

/**
 * Fits y = a |x - x0|^p + b to energies measured around a null, with p from 1 (V-shaped:
 * short dark dips such as OLED refresh) to 2 (U-shaped: smooth flicker), x0 searched over
 * the sampled range. Null if the dip doesn't open upwards.
 */
export function nullFit(points: { x: number; y: number }[]): NullFit | null {
  if (points.length < 4) return null;
  const xs = points.map((p) => p.x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  let best: (NullFit & { sse: number }) | null = null;
  for (const pw of [1, 1.25, 1.5, 1.75, 2]) {
    for (let i = 0; i <= 200; i++) {
      const x0 = lo + ((hi - lo) * i) / 200;
      // Linear least squares for a, b with u = |x - x0|^p.
      let su = 0, sy = 0, suu = 0, suy = 0;
      for (const p of points) {
        const u = Math.abs(p.x - x0) ** pw;
        su += u;
        sy += p.y;
        suu += u * u;
        suy += u * p.y;
      }
      const n = points.length;
      const den = n * suu - su * su;
      if (Math.abs(den) < 1e-300) continue;
      const a = (n * suy - su * sy) / den;
      if (!(a > 0)) continue;
      const b = (sy - a * su) / n;
      let sse = 0;
      for (const p of points) sse += (p.y - a * Math.abs(p.x - x0) ** pw - b) ** 2;
      if (!best || sse < best.sse) best = { x0, a, p: pw, b, sse };
    }
  }
  return best && { x0: best.x0, a: best.a, p: best.p, b: best.b };
}

/** Position of a null from energies measured around it, see nullFit(). */
export function nullVertex(points: { x: number; y: number }[]): number | null {
  return nullFit(points)?.x0 ?? null;
}

/** Shutter angle in degrees for an exposure at a frame rate. */
export function shutterAngle(exposure: number, fps: number): number {
  return 360 * fps * exposure;
}

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
