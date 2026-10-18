// Coherent band model over the whole sweep, using the frames' capture times.
//
// For harmonic h, a frame captured at time t with exposure E shows
// Re{z_h(E) e^{i 2 pi h f t} P_h}, where z_h(E) = (1 - e^{-ib}) / (ib), b = 2 pi h f E, is
// the average over the exposure window and P_h an unknown complex pattern. A step's mean
// therefore carries z_h(E) times the mean of e^{i 2 pi h f t} over its frames:
//
//   mean_step = content + sum_h Re{ z_h(E) phi_h(step) P_h },
//
// linear in the unknown patterns. Standing, drifting and rolling bands are all this model
// with the right f, so it covers the cases where comparing nulls fails: bands that drift
// slowly over the sweep, or whose pattern repeats over more than the analysed area. The
// band phase accumulates over the whole sweep, which pins f down to ~0.1 / (sweep duration).

import { gramOf, invert, type FlickerFit, type SweepModel } from './analysis';

export interface CoherentFit {
  frequency: number;
  /** Fraction of the band variance in the step means that the model explains (0..1). */
  explained: number;
  /**
   * How far the chosen frequency's peak in the broad scan stands out from the scan's
   * typical values, in robust standard deviations (median absolute deviation x 1.4826).
   */
  significance?: number;
  /** Diagnostics: the best candidates with their explained variance and significance. */
  candidates?: { f: number; explained: number; significance: number }[];
  /** Content estimate as weights over model.steps (content = sum w_i mean_i). */
  weights: Float64Array;
}

/** Harmonics in the polished model: short dark dips (OLED refresh) need more than smooth flicker. */
const HARMONICS = 6;
/** Broad scan range for the fundamental, Hz. Above it the null-based fit is reliable. */
const SCAN_MIN = 40;
const SCAN_MAX = 330;
/** Candidates from the null-based fit are checked up to this frequency (its own range). */
const CANDIDATE_MAX = 3000;
/** Fits explaining within this much of the best count as tied. */
const TIE = 0.01;

/** Precomputed pieces of the coherent model for one sweep. */
export class CoherentModel {
  private readonly idx: number[];
  private readonly t0: number;
  readonly duration: number;
  /** Low-rank factor of the steps' Gram matrix: G ~ L L^T (rows = idx, r columns). */
  private readonly L: Float64Array[];
  private readonly constOnly: number;
  private readonly total: number;

  constructor(
    private readonly model: SweepModel,
    minExposure: number,
  ) {
    const n = model.steps.length;
    this.idx = model.steps.flatMap((s, i) => (s.exposure >= minExposure && s.times.length ? [i] : []));
    const times = this.idx.flatMap((i) => model.steps[i].times);
    this.t0 = times.length ? Math.min(...times) : 0;
    this.duration = times.length ? Math.max(...times) - this.t0 : 0;
    const m = this.idx.length;
    const sub = new Float64Array(m * m);
    this.idx.forEach((i, a) =>
      this.idx.forEach((j, b) => {
        sub[a * m + b] = model.G[i * n + j];
      }),
    );
    this.L = pivotedCholesky(sub, m, 40, 1e-7);
    // Normalise with the same (positive semi-definite) approximation G ~ L L^T as the fits,
    // so the explained fraction stays within [0, 1] even when noise makes G indefinite.
    let llTrace = 0;
    let ones = 0;
    for (const col of this.L) {
      let s1 = 0;
      for (let r = 0; r < m; r++) {
        llTrace += col[r] * col[r];
        s1 += col[r];
      }
      ones += s1 * s1;
    }
    this.constOnly = m ? ones / m : 0;
    this.total = llTrace - this.constOnly;
  }

  get usable(): boolean {
    return this.idx.length >= 1 + 2 * HARMONICS + 3 && this.duration > 0 && this.total > 0 && this.L.length > 0;
  }

  /** Design matrix rows for frequency f with `harmonics` harmonics. */
  private design(f: number, harmonics: number, phases?: { re: Float64Array; im: Float64Array; offsets: number[] }): number[][] {
    return this.idx.map((i, r) => {
      const { exposure: e, times } = this.model.steps[i];
      const row = [1];
      for (let h = 1; h <= harmonics; h++) {
        const b = 2 * Math.PI * h * f * e;
        const zr = Math.sin(b) / b;
        const zi = (Math.cos(b) - 1) / b;
        let pr = 0;
        let pi = 0;
        if (h === 1 && phases) {
          // Precomputed e^{i 2 pi f t} of the step's frames (scan fast path).
          const o = phases.offsets[r];
          for (let k = 0; k < times.length; k++) {
            pr += phases.re[o + k];
            pi += phases.im[o + k];
          }
        } else {
          for (const t of times) {
            const th = 2 * Math.PI * h * f * (t - this.t0);
            pr += Math.cos(th);
            pi += Math.sin(th);
          }
        }
        pr /= times.length;
        pi /= times.length;
        row.push(zr * pr - zi * pi, -(zr * pi + zi * pr));
      }
      return row;
    });
  }

  /** Explained band variance of the model at frequency f; also returns the fit for weights. */
  private evaluate(X: number[][]): { explained: number; Ainv: number[][] } | null {
    const Ainv = invert(gramOf(X));
    if (!Ainv) return null;
    const p = X[0].length;
    // Y = L^T X (r x p); trace((X^T X)^-1 X^T L L^T X) = trace(Ainv Y^T Y).
    const Y = this.L.map((col) => {
      const y = new Array(p).fill(0);
      for (let r = 0; r < X.length; r++) {
        const l = col[r];
        if (l) for (let c = 0; c < p; c++) y[c] += l * X[r][c];
      }
      return y;
    });
    let tr = 0;
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) {
        let yy = 0;
        for (const y of Y) yy += y[a] * y[b];
        tr += Ainv[a][b] * yy;
      }
    }
    return { explained: (tr - this.constOnly) / this.total, Ainv };
  }

  /**
   * Explained variance of the fundamental-only model over [fLo, fHi], sampled at
   * `resolution` x 0.1 / duration. Phases are rotated incrementally instead of recomputed.
   */
  scan(fLo: number, fHi: number, resolution = 2.5): { f: number; explained: number }[] {
    const df = (0.1 * resolution) / this.duration;
    const offsets: number[] = [];
    const frameTimes: number[] = [];
    for (const i of this.idx) {
      offsets.push(frameTimes.length);
      for (const t of this.model.steps[i].times) frameTimes.push(t - this.t0);
    }
    const re = new Float64Array(frameTimes.length);
    const im = new Float64Array(frameTimes.length);
    const wr = new Float64Array(frameTimes.length);
    const wi = new Float64Array(frameTimes.length);
    frameTimes.forEach((t, k) => {
      re[k] = Math.cos(2 * Math.PI * fLo * t);
      im[k] = Math.sin(2 * Math.PI * fLo * t);
      wr[k] = Math.cos(2 * Math.PI * df * t);
      wi[k] = Math.sin(2 * Math.PI * df * t);
    });
    const out: { f: number; explained: number }[] = [];
    let step = 0;
    for (let f = fLo; f <= fHi; f += df, step++) {
      if (step % 256 === 0 && step) {
        // Re-anchor the rotation to keep rounding errors from accumulating.
        frameTimes.forEach((t, k) => {
          re[k] = Math.cos(2 * Math.PI * f * t);
          im[k] = Math.sin(2 * Math.PI * f * t);
        });
      }
      const r = this.evaluate(this.design(f, 1, { re, im, offsets }));
      out.push({ f, explained: r ? r.explained : -Infinity });
      for (let k = 0; k < re.length; k++) {
        const nr = re[k] * wr[k] - im[k] * wi[k];
        im[k] = re[k] * wi[k] + im[k] * wr[k];
        re[k] = nr;
      }
    }
    return out;
  }

  /** Best full-harmonic fit within f0 +- halfWidth (fine grid). */
  polish(f0: number, halfWidth: number, harmonics = HARMONICS): CoherentFit | null {
    const steps = 24;
    let best: { f: number; explained: number; X: number[][]; Ainv: number[][] } | null = null;
    for (let k = -steps; k <= steps; k++) {
      const f = f0 + (halfWidth * k) / steps;
      const X = this.design(f, harmonics);
      const r = this.evaluate(X);
      if (r && (!best || r.explained > best.explained)) best = { f, explained: r.explained, X, Ainv: r.Ainv };
    }
    if (!best) return null;
    const fit = best;
    const weights = new Float64Array(this.model.steps.length);
    const p = fit.X[0].length;
    this.idx.forEach((i, r) => {
      let w = 0;
      for (let c = 0; c < p; c++) w += fit.Ainv[0][c] * fit.X[r][c];
      weights[i] = w;
    });
    return { frequency: fit.f, explained: fit.explained, weights };
  }
}

/**
 * Finds the flicker frequency with the coherent model: a broad scan of the fundamental
 * plus the null-based fit's candidates, each polished with all harmonics; the best
 * explained wins. On a near-tie with an integer multiple the multiple wins (a sub-multiple
 * mimics it through its harmonics), except that a lower frequency the null-based fit chose
 * on purpose (sub-harmonic of two flicker sources) is kept: its clean shutter speeds are
 * clean for the higher one too.
 */
export function coherentFrequency(model: SweepModel, fit: FlickerFit): CoherentFit | null {
  const cm = new CoherentModel(model, 0.6 / Math.min(fit.frequency, SCAN_MAX));
  if (!cm.usable) return null;
  const T = cm.duration;
  const scan = cm.scan(Math.max(SCAN_MIN, 1 / model.eMax), SCAN_MAX);
  const peaks = scan
    .filter((p, i) => p.explained >= (scan[i - 1]?.explained ?? -Infinity) && p.explained >= (scan[i + 1]?.explained ?? -Infinity))
    .sort((a, b) => b.explained - a.explained);
  const pool: number[] = [];
  const add = (f: number) => {
    if (f >= SCAN_MIN && f <= CANDIDATE_MAX && pool.every((p) => Math.abs(Math.log(f / p)) > 0.004)) pool.push(f);
  };
  peaks.slice(0, 12).forEach((p) => add(p.f));
  // Candidates above the broad scan: search their neighbourhood with the fundamental and
  // keep that local scan to judge their significance against.
  const localScans: { f: number; scan: { f: number; explained: number }[] }[] = [];
  for (const f of [fit.frequency, ...(fit.candidates ?? [])]) {
    if (f > SCAN_MAX && f <= CANDIDATE_MAX) {
      const local = cm.scan(f * 0.97, f * 1.03);
      const top = local.reduce((a, b) => (b.explained > a.explained ? b : a), local[0]);
      if (top) {
        add(top.f);
        localScans.push({ f: top.f, scan: local });
      }
    }
  }
  if (fit.frequency <= SCAN_MAX) add(fit.frequency);
  const fits = pool.flatMap((f) => cm.polish(f, 0.3 / T) ?? []);
  if (!fits.length) return null;
  const top = Math.max(...fits.map((c) => c.explained));
  let chosen = fits.find((c) => c.explained === top)!;
  // A sub-multiple mimics a frequency through its harmonics: prefer the multiple on a tie.
  for (const c of fits) {
    const k = c.frequency / chosen.frequency;
    if (Math.round(k) >= 2 && Math.abs(k - Math.round(k)) < 0.01 * k && c.explained >= top - TIE) chosen = c;
  }
  // Safety: keep the null-based fit's frequency when the chosen one is a multiple of it.
  const own = fits.find((c) => Math.abs(c.frequency / fit.frequency - 1) < 0.01);
  const k = chosen.frequency / fit.frequency;
  if (own && own !== chosen && Math.round(k) >= 2 && Math.abs(k - Math.round(k)) < 0.02 * k && own.explained >= top - 0.05) chosen = own;
  const significanceOf = (f: number) => {
    const local = localScans.find((l) => Math.abs(l.f / f - 1) < 0.03);
    return scanSignificance(f > SCAN_MAX && local ? local.scan : scan, f, T);
  };
  const candidates = [...fits]
    .sort((a, b) => b.explained - a.explained)
    .slice(0, 6)
    .map((c) => ({ f: +c.frequency.toFixed(3), explained: +c.explained.toFixed(4), significance: +significanceOf(c.frequency).toFixed(2) }));
  return { ...chosen, significance: significanceOf(chosen.frequency), candidates };
}

/** Robust z-score of the scan's maximum within 1 / duration of f, against the whole scan. */
function scanSignificance(scan: { f: number; explained: number }[], f: number, T: number): number {
  const vals = scan.map((p) => p.explained).filter(Number.isFinite);
  if (vals.length < 10) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const mad = [...vals.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[vals.length >> 1] * 1.4826;
  const near = scan.filter((p) => Math.abs(p.f - f) <= 1 / T).map((p) => p.explained);
  if (!near.length || !(mad > 0)) return 0;
  return (Math.max(...near) - med) / mad;
}

/** Pivoted incomplete Cholesky of a symmetric (near-)PSD m x m matrix: columns of L. */
function pivotedCholesky(A: Float64Array, m: number, maxRank: number, relTol: number): Float64Array[] {
  const diag = new Float64Array(m);
  let trace = 0;
  for (let i = 0; i < m; i++) {
    diag[i] = A[i * m + i];
    trace += Math.max(0, diag[i]);
  }
  const L: Float64Array[] = [];
  for (let k = 0; k < Math.min(maxRank, m); k++) {
    let piv = 0;
    for (let i = 1; i < m; i++) if (diag[i] > diag[piv]) piv = i;
    if (!(diag[piv] > relTol * trace)) break;
    const col = new Float64Array(m);
    const d = Math.sqrt(diag[piv]);
    for (let i = 0; i < m; i++) {
      let v = A[i * m + piv];
      for (const c of L) v -= c[i] * c[piv];
      col[i] = v / d;
    }
    for (let i = 0; i < m; i++) diag[i] -= col[i] * col[i];
    L.push(col);
  }
  return L;
}
