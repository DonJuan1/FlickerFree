// Measurement flow: ISO calibration, coarse exposure sweep, flicker-frequency fit,
// then fine refinement around the clean value closest to 180 degrees.

import {
  SweepModel,
  cleanExposures,
  closestTo,
  exposureGrid,
  fitContent,
  fitFlicker,
  isFlicker,
  parabolaVertex,
  snapExposure,
  stepProfile,
  type FlickerFit,
  type FrameSample,
  type StepProfile,
} from './analysis';

export interface Range {
  min: number;
  max: number;
  /** 0 = continuous. */
  step: number;
}

/** What the measurement needs from a camera. Exposures are in seconds. */
export interface MeasureCamera {
  exposure: Range;
  iso?: Range;
  setExposure(exposure: number, iso?: number): Promise<void>;
  /** Drops `discard` frames (pipeline latency), then returns the next `count`. */
  capture(discard: number, count: number): Promise<FrameSample[]>;
}

export interface MeasureOptions {
  /** Project frame rate of the cinema camera; sets 360 degrees and the 180 degree target. */
  fps: number;
  /** Fastest shutter tested, seconds. */
  fastest?: number;
  /** Ratio between consecutive coarse steps. */
  ratio?: number;
  /** Frames dropped after each exposure change. */
  discard?: number;
  framesPerStep?: number;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}

export interface Progress {
  phase: 'calibrate' | 'sweep' | 'analyse' | 'refine';
  done: number;
  total: number;
  exposure?: number;
}

export interface StepRecord {
  phase: Progress['phase'];
  exposure: number;
  iso?: number;
  meanLuma: number;
  clipFraction: number;
  valid: boolean;
  /** Band energy against the fitted nulls (filled in after the fit). */
  energy?: number;
  profile: StepProfile;
}

interface Common {
  /** Shutter range offered as results, seconds. */
  range: [number, number];
  /** Exposure range swept, seconds (wider than range so low frequencies show two nulls). */
  swept: [number, number];
  steps: StepRecord[];
  /** Steps skipped because the image was too bright or too dark. */
  skipped: number;
  fit: FlickerFit | null;
}

export type MeasureResult =
  | (Common & { kind: 'flicker'; frequency: number; best: number; clean: number[]; refined: boolean })
  | (Common & { kind: 'no-clean'; frequency: number })
  | (Common & { kind: 'none' })
  | (Common & { kind: 'error'; message: string });

const TARGET_LUMA = 115;
const MIN_LUMA = 12;
const MAX_CLIP = 0.02;
/** Minimum explained band variance to trust the band-model content estimate. */
const CONTENT_MODEL_MIN = 0.95;
/** The sweep always reaches at least this long, so flicker down to ~40 Hz shows two nulls. */
const MIN_SWEEP_MAX = 1 / 20;

export async function measure(cam: MeasureCamera, opt: MeasureOptions): Promise<MeasureResult> {
  const discard = opt.discard ?? 5;
  const perStep = opt.framesPerStep ?? 5;
  const eMin = Math.max(opt.fastest ?? 1 / 250, cam.exposure.min);
  const resultMax = Math.min(1 / opt.fps, cam.exposure.max);
  const sweepMax = Math.min(Math.max(MIN_SWEEP_MAX, 1 / opt.fps), cam.exposure.max);
  const steps: StepRecord[] = [];
  const range: [number, number] = [eMin, resultMax];
  const swept: [number, number] = [eMin, sweepMax];
  let fit: FlickerFit | null = null;
  const common = (): Common => ({ range, swept, steps, skipped: steps.filter((s) => !s.valid).length, fit });
  if (!(resultMax > eMin)) {
    return { ...common(), kind: 'error', message: 'The camera does not support the needed exposure range.' };
  }

  const grid = exposureGrid(eMin, sweepMax, opt.ratio ?? 1.025, cam.exposure.step);
  const refineEstimate = 54;
  let total = 4 + grid.length + refineEstimate;
  let done = 0;
  const progress = (phase: Progress['phase'], exposure?: number) => opt.onProgress?.({ phase, done, total, exposure });
  const checkAbort = () => {
    if (opt.signal?.aborted) throw new DOMException('Measurement stopped', 'AbortError');
  };

  // ISO calibration: keep exposure x ISO constant so every step has the same brightness.
  let isoFor: (e: number) => number | undefined = () => undefined;
  if (cam.iso) {
    const isoRange = cam.iso;
    const clampIso = (v: number) => {
      const c = Math.min(isoRange.max, Math.max(isoRange.min, v));
      return isoRange.step > 0 ? Math.round(c / isoRange.step) * isoRange.step : c;
    };
    const eRef = snapExposure(Math.sqrt(eMin * sweepMax), cam.exposure.step);
    let iso = clampIso(400);
    for (let i = 0; i < 4; i++) {
      checkAbort();
      progress('calibrate', eRef);
      await cam.setExposure(eRef, iso);
      const frames = await cam.capture(discard, 3);
      done++;
      const rec = record('calibrate', eRef, iso, frames);
      steps.push(rec);
      if (rec.meanLuma > TARGET_LUMA * 0.8 && rec.meanLuma < TARGET_LUMA * 1.25) break;
      const next = clampIso(iso * Math.min(4, Math.max(0.25, Math.pow(TARGET_LUMA / Math.max(rec.meanLuma, 1), 2.2))));
      if (next === iso) break;
      iso = next;
    }
    const k = eRef * iso;
    isoFor = (e) => clampIso(k / e);
  }
  total = done + grid.length + refineEstimate;

  const step = async (phase: Progress['phase'], e: number): Promise<StepRecord> => {
    checkAbort();
    progress(phase, e);
    const iso = isoFor(e);
    await cam.setExposure(e, iso);
    const frames = await cam.capture(discard, perStep);
    done++;
    const rec = record(phase, e, iso, frames);
    steps.push(rec);
    return rec;
  };

  for (const e of grid) await step('sweep', e);

  const valid = steps.filter((s) => s.phase === 'sweep' && s.valid);
  if (valid.length < 6) {
    return {
      ...common(),
      kind: 'error',
      message: 'The image was too bright or too dark at most shutter speeds. Lower the screen brightness or move closer.',
    };
  }
  progress('analyse');
  // Let the UI paint the analysing state before the synchronous fit.
  await new Promise((r) => setTimeout(r, 0));
  const model = new SweepModel(valid.map((s) => s.profile));
  fit = fitFlicker(model);
  if (!isFlicker(fit)) return { ...common(), kind: 'none' };

  // Band energy reference: the content estimate from the band-model fit when the model
  // explains the sweep (bands standing still between frames), else the centroid of the
  // predicted nulls (rolling bands, where comparing nulls is reliable).
  let frequency = fit.frequency;
  const content = fitContent(model, frequency);
  const anchors = fit.anchors;
  let energyOf = (p: StepProfile) => model.energyOf(p, anchors);
  if (content && content.explained >= CONTENT_MODEL_MIN) {
    frequency = content.frequency;
    energyOf = (p) => model.energyVsContent(p, content.weights);
  }
  for (const s of valid) s.energy = energyOf(s.profile);
  const target = 1 / (2 * opt.fps);
  let best = closestTo(cleanExposures(frequency, eMin, resultMax), target);
  if (best === undefined) return { ...common(), kind: 'no-clean', frequency };

  // Refinement: measure finely around the chosen null, sweeping up and then down so the
  // camera's settling lag cancels, and take the vertex of a parabola through the energies.
  const n = Math.round(best * frequency);
  let center = best;
  let half = Math.min(0.04, 0.3 / n);
  let refined = false;
  total = done + refineEstimate;
  for (let iter = 0; iter < 3; iter++) {
    const values = [
      ...new Set(Array.from({ length: 9 }, (_, i) => snapExposure(center * (1 - half + (2 * half * i) / 8), cam.exposure.step))),
    ].filter((e) => e >= cam.exposure.min && e <= cam.exposure.max);
    if (values.length < 3) break;
    const sums = new Map<number, { s: number; c: number }>();
    for (const e of [...values, ...[...values].reverse()]) {
      const rec = await step('refine', e);
      if (!rec.valid) continue;
      rec.energy = energyOf(rec.profile);
      const acc = sums.get(e) ?? { s: 0, c: 0 };
      acc.s += rec.energy;
      acc.c++;
      sums.set(e, acc);
    }
    const pts = [...sums].map(([x, { s, c }]) => ({ x, y: s / c }));
    if (pts.length < 3) break;
    const vertex = parabolaVertex(pts) ?? pts.reduce((a, b) => (b.y < a.y ? b : a)).x;
    if (Math.abs(vertex / center - 1) > half) break;
    refined = true;
    const moved = Math.abs(vertex / center - 1);
    center = vertex;
    frequency = n / center;
    if (moved < 0.001) break;
    half = Math.max(half / 2, (2.5 * cam.exposure.step) / center);
  }

  const clean = cleanExposures(frequency, eMin, resultMax);
  best = closestTo(clean, target) ?? center;
  return { ...common(), kind: 'flicker', frequency, best, clean, refined };
}

function record(phase: Progress['phase'], exposure: number, iso: number | undefined, frames: FrameSample[]): StepRecord {
  const meanLuma = avg(frames.map((f) => f.meanLuma));
  const clipFraction = avg(frames.map((f) => f.clipFraction));
  return {
    phase,
    exposure,
    iso,
    meanLuma,
    clipFraction,
    valid: frames.length >= 2 && meanLuma >= MIN_LUMA && clipFraction <= MAX_CLIP,
    profile: stepProfile(exposure, frames),
  };
}

function avg(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
