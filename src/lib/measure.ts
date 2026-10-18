// Measurement flow: ISO calibration, coarse exposure sweep, flicker-frequency fit,
// then fine refinement around the clean value closest to 180 degrees.

import { coherentFrequency } from './coherent';
import {
  SweepModel,
  cleanExposures,
  closestTo,
  exposureGrid,
  fitFlicker,
  isFlicker,
  nullContrast,
  nullFit,
  snapExposure,
  stepProfile,
  type FlickerFit,
  type FrameSample,
  type NullFit,
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
  /** Makes the next frame the alignment reference (frames are aligned against hand shake). */
  resetAlignment?(): void;
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
  /** Sweep order; default two interleaved passes. */
  order?: 'monotonic' | 'twoPass';
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
  /** Frames dropped because alignment failed or the screen moved out of the region. */
  unaligned: number;
  /** Mean alignment offset of the step's frames (analysis pixels). */
  shift?: [number, number];
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
  /**
   * Brightness calibration: k = exposure x ISO (exposure alone without ISO control) for the
   * target luma, null if unknown; whether the measured luma followed ISO and exposure
   * changes (null: not tested).
   */
  calibration?: { k: number | null; isoControl: boolean; exposureControl: boolean | null };
  /** Parts of the sweep left out because the screen was too dark (fast) or bright (slow). */
  limited?: { fast: boolean; slow: boolean };
  /** The coherent model's best candidate, trusted or not (diagnostics). */
  coherent?: {
    frequency: number;
    explained: number;
    nullContrast: number;
    significance: number;
    candidates?: { f: number; explained: number; significance: number; nullContrast?: number }[];
  };
}

/** Which content reference the result was refined against (see measure()). */
export type Reference = 'coherent' | 'average' | 'anchors';

export type MeasureResult =
  | (Common & {
      kind: 'flicker';
      frequency: number;
      best: number;
      clean: number[];
      refined: boolean;
      reference: Reference;
      explained?: number;
      /** False when the frequency could not be pinned down reliably (show as a best guess). */
      confident: boolean;
    })
  | (Common & { kind: 'no-clean'; frequency: number })
  | (Common & { kind: 'none' })
  | (Common & { kind: 'error'; reason: 'too-bright' | 'too-dark' | 'moved' | 'exposure' | 'camera'; message: string });

/** Calibration target for the mean luma (0-255): leaves headroom for longer exposures. */
const TARGET_LUMA = 80;
/** A step is unusable below this mean luma or above this fraction of clipped pixels. */
const MIN_LUMA = 10;
const MAX_CLIP = 0.02;
/**
 * Usable brightness relative to the target, as exposure factors (luma ~ exposure^(1/2.2)):
 * 8x brighter is mean luma ~205, 1/16 is ~23. Within this window the analysis works (it
 * compares log brightness, so a constant gain cancels); beyond it frames clip or drown.
 */
const MAX_OVER = 8;
const MIN_UNDER = 1 / 16;
const TOO_BRIGHT =
  "The screen is too bright for this phone camera at the shutter speeds needed. Show a darker grey image on it and try again. (Leave the screen's brightness setting as it will be on set: it can change how the screen flickers.)";
const TOO_DARK = 'The screen is too dark for this phone camera. Show a lighter grey image on it and try again.';
/** The sweep must reach at least this long and span at least this ratio to be useful. */
const MIN_USEFUL_MAX = 1 / 100;
const MIN_USEFUL_SPAN = 3;
/** Largest change the refinement may make to the coarse estimate (relative). */
const MAX_REFINE_MOVE = 0.03;
/** Minimum explained band variance for the coherent model to be trusted. */
const COHERENT_MIN = 0.3;
/**
 * Minimum significance of the coherent frequency's peak in the broad scan (robust z).
 * Correct identifications scored 16-41 (simulation and browser tests with a synthetic
 * camera), wrong ones at most ~12 (busy screen content plus hand shake).
 */
const COHERENT_SIGNIFICANCE = 15;
/** The null-based fit counts as confident only with this dip contrast and a refinement. */
const CONFIDENT_CONTRAST = 0.9;
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
  let coherentInfo: Common['coherent'];
  let calibration: Common['calibration'];
  let limited: Common['limited'];
  const common = (): Common => ({
    range,
    swept,
    steps,
    skipped: steps.filter((s) => s.phase !== 'calibrate' && !s.valid).length,
    fit,
    coherent: coherentInfo,
    calibration,
    limited,
  });
  if (!(resultMax > eMin)) {
    return { ...common(), kind: 'error', reason: 'camera', message: 'The camera does not support the needed exposure range.' };
  }

  const refineEstimate = 72;
  let total = 8 + 104 + refineEstimate;
  let done = 0;
  const progress = (phase: Progress['phase'], exposure?: number) => opt.onProgress?.({ phase, done, total, exposure });
  const checkAbort = () => {
    if (opt.signal?.aborted) throw new DOMException('Measurement stopped', 'AbortError');
  };

  // Brightness calibration: find k = exposure x ISO giving the target luma. ISO is
  // adjusted first; once it hits a limit the exposure moves instead, so a very bright or
  // dark screen can still be measured over part of the sweep. (Phone cameras have a fixed
  // aperture and a minimum ISO: a bright screen can be too bright for long exposures.)
  // Each change is checked against the measured luma: a camera that ignores the ISO is
  // driven by exposure alone; one whose brightness doesn't follow the exposure either
  // (still adjusting itself) gets the full sweep, judged step by step on its own luma.
  const isoRange = cam.iso;
  const clampIso = (v: number) => {
    if (!isoRange) return 1;
    const c = Math.min(isoRange.max, Math.max(isoRange.min, v));
    return isoRange.step > 0 ? Math.round(c / isoRange.step) * isoRange.step : c;
  };
  type Sample = { e: number; iso: number; L: number; clip: number };
  const usable = (s: Sample) => s.clip <= MAX_CLIP && s.L >= 2 * MIN_LUMA && s.L <= 200;
  const measurable = (s: Sample) => s.clip <= 0.5 && s.L >= MIN_LUMA && s.L <= 240;
  let e = snapExposure(Math.sqrt(eMin * sweepMax), cam.exposure.step);
  let iso = clampIso(isoRange ? Math.sqrt(isoRange.min * isoRange.max) : 1);
  let isoWorks = isoRange !== undefined;
  let exposureWorks: boolean | undefined;
  let prev: Sample | null = null;
  let closest: Sample | null = null;
  for (let i = 0; i < 8; i++) {
    checkAbort();
    progress('calibrate', e);
    await cam.setExposure(e, isoRange ? iso : undefined);
    // Extra frames dropped: a change only counts once it has surely taken effect.
    const rec = record('calibrate', e, isoRange ? iso : undefined, await cam.capture(discard + 3, 3));
    done++;
    steps.push(rec);
    const cur: Sample = { e, iso, L: Math.max(rec.meanLuma, 1), clip: rec.clipFraction };
    if (prev && measurable(prev) && measurable(cur)) {
      const r = (cur.e * cur.iso) / (prev.e * prev.iso);
      // Luma ~ (exposure x ISO)^(1/2.2); a quarter of that change counts as a response.
      const responds = Math.log(cur.L / prev.L) / Math.log(r) > 0.25 / 2.2;
      if (Math.abs(Math.log(r)) >= Math.log(2)) {
        if (cur.e === prev.e) isoWorks = responds;
        else if (cur.iso === prev.iso) exposureWorks = responds;
      }
    }
    prev = cur;
    if (exposureWorks === false) break;
    const off = (s: Sample) => Math.abs(Math.log(s.L / TARGET_LUMA));
    if (usable(cur) && (!closest || off(cur) < off(closest))) closest = cur;
    if (usable(cur) && cur.L > TARGET_LUMA * 0.7 && cur.L < TARGET_LUMA * 1.4) break;
    const factor = cur.clip > MAX_CLIP ? 1 / 8 : Math.min(16, Math.max(1 / 16, Math.pow(TARGET_LUMA / cur.L, 2.2)));
    if (isoWorks) {
      const nextIso = clampIso(iso * factor);
      if (nextIso !== iso) {
        iso = nextIso;
        continue;
      }
    }
    // Calibrated within the sweep: exposures beyond it would also slow the frame rate.
    const nextE = snapExposure(Math.min(sweepMax, Math.max(eMin, e * factor)), cam.exposure.step);
    if (nextE === e) break;
    e = nextE;
  }
  const controlled = exposureWorks !== false;
  // Brightness-relevant product: ISO counts only if the camera follows it.
  const gain = (ex: number, is: number) => ex * (isoWorks ? is : 1);
  const k = closest ? gain(closest.e, closest.iso) * Math.pow(TARGET_LUMA / closest.L, 2.2) : NaN;
  calibration = { k: controlled && closest ? k : null, isoControl: isoWorks, exposureControl: exposureWorks ?? null };
  if (controlled && !closest) {
    const bright = !!prev && (prev.clip > MAX_CLIP || prev.L > 200);
    return { ...common(), kind: 'error', reason: bright ? 'too-bright' : 'too-dark', message: bright ? TOO_BRIGHT : TOO_DARK };
  }
  const fixedIso = iso;
  const isoFor = (ex: number) => (!isoRange ? undefined : isoWorks && controlled ? clampIso(k / ex) : fixedIso);
  // Brightness of a step relative to the target, with ISO clamped to its range.
  const relative = (ex: number) => gain(ex, isoFor(ex) ?? 1) / k;

  // Sweep only the exposures this camera can capture at a usable brightness.
  const full = exposureGrid(eMin, sweepMax, opt.ratio ?? 1.025, cam.exposure.step);
  const grid = controlled ? full.filter((ex) => relative(ex) <= MAX_OVER && relative(ex) >= MIN_UNDER) : full;
  const lo = grid[0];
  const hi = grid[grid.length - 1];
  if (!grid.length || hi < MIN_USEFUL_MAX || hi / lo < MIN_USEFUL_SPAN) {
    const bright = !grid.length ? relative(eMin) > MAX_OVER : hi < MIN_USEFUL_MAX || relative(full[full.length - 1]) > MAX_OVER;
    return { ...common(), kind: 'error', reason: bright ? 'too-bright' : 'too-dark', message: bright ? TOO_BRIGHT : TOO_DARK };
  }
  swept[0] = lo;
  swept[1] = hi;
  if (controlled) limited = { fast: lo > full[0], slow: hi < full[full.length - 1] };

  // Align everything to a frame at the mid exposure: moderate bands, low noise.
  const eAlign = snapExposure(Math.sqrt(lo * hi), cam.exposure.step);
  await cam.setExposure(eAlign, isoFor(eAlign));
  await cam.capture(discard, 0);
  cam.resetAlignment?.();
  await cam.capture(0, 1);
  total = done + grid.length + refineEstimate;

  let stepCount = 0;
  const step = async (phase: Progress['phase'], e: number): Promise<StepRecord> => {
    checkAbort();
    progress(phase, e);
    const iso = isoFor(e);
    await cam.setExposure(e, iso);
    // Uneven step lengths: with equal ones, flicker frequencies 1 / (step duration) apart
    // look alike to the coherent model.
    const frames = await cam.capture(discard + (stepCount++ % 3), perStep);
    done++;
    const rec = record(phase, e, iso, frames);
    steps.push(rec);
    return rec;
  };

  // Two interleaved passes: even steps going up, odd steps coming down. If exposure rose
  // steadily with time, a band drifting slowly over the sweep would look like a frequency
  // offset; this way neighbouring exposures are measured far apart in time, while each
  // change between consecutive steps stays small (settling lag barely matters).
  for (const e of opt.order === 'monotonic' ? grid : twoPass(grid)) await step('sweep', e);

  const sweep = steps.filter((s) => s.phase === 'sweep');
  const valid = sweep.filter((s) => s.valid);
  if (valid.length < 6) {
    const moved = sweep.filter((s) => s.unaligned > s.profile.times.length).length > sweep.length / 2;
    return {
      ...common(),
      kind: 'error',
      reason: moved ? 'moved' : 'exposure',
      message: moved
        ? 'The phone moved too much. Rest it against something or hold it very still and try again.'
        : 'Most shutter speeds gave an unusable image (too bright or too dark). Show a plain grey image on the screen and try again.',
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
  // Content references for band energies, as weights over the sweep's step means:
  //  - model:   band-model fit (separates content from standing bands),
  //  - average: mean of the steps beyond the first null (moving bands cancel),
  //  - anchors: centroid of the steps at the predicted nulls.
  // Each can carry leftover band; with moving bands the refinement keeps whichever reaches
  // the lowest dip, since at a true null the band vanishes against a clean reference.
  let frequency = fit.frequency;
  // Coherent check: the band model over all frames with their capture times pins the
  // frequency down to ~0.1 / (sweep duration) and tells real from spurious candidates.
  // Trusted when its peak stands out clearly in the broad scan; it is then final.
  progress('analyse');
  await new Promise((r) => setTimeout(r, 0));
  const coh = coherentFrequency(model, fit);
  coherentInfo = coh
    ? {
        frequency: coh.frequency,
        explained: coh.explained,
        nullContrast: nullContrast(model, coh.frequency),
        significance: coh.significance ?? 0,
        candidates: coh.candidates?.map((c) => ({ ...c, nullContrast: +nullContrast(model, c.f).toFixed(3) })),
      }
    : undefined;
  const coherent = coh && (coh.significance ?? 0) >= COHERENT_SIGNIFICANCE && coh.explained >= COHERENT_MIN ? coh : null;
  if (coherent) frequency = coherent.frequency;
  // Otherwise refine against content references built from the sweep (see below).
  const average = new Float64Array(model.steps.length);
  {
    const use = model.steps.map((s) => s.exposure >= 0.9 / frequency);
    const count = use.filter(Boolean).length;
    model.steps.forEach((_, i) => {
      if (count >= 8 ? use[i] : true) average[i] = 1 / (count >= 8 ? count : model.steps.length);
    });
  }
  const references: { name: Reference; w: Float64Array }[] = coherent
    ? [{ name: 'coherent', w: coherent.weights }]
    : [
        { name: 'average', w: average },
        { name: 'anchors', w: model.anchorWeights(fit.anchors) },
      ];
  const primary = references[0];
  for (const s of valid) s.energy = model.energyVsContent(s.profile, primary.w);
  const target = 1 / (2 * opt.fps);
  let best = closestTo(cleanExposures(frequency, eMin, resultMax), target);
  if (best === undefined) return { ...common(), kind: 'no-clean', frequency };

  // Refinement (when the coherent model isn't trusted): measure finely around the chosen
  // null, sweeping up and then down so the camera's settling lag cancels, and locate the
  // bottom of the dip in the energies against two content references from the sweep:
  //  - average: mean of the steps beyond the first null (moving bands cancel),
  //  - anchors: centroid of the steps at the predicted nulls;
  // whichever reaches the lowest dip wins, since at a true null the band vanishes against a
  // clean reference. The up/down repeats give the noise level; a window whose edges don't
  // rise clearly above it is widened (up to the neighbouring antinodes), else the estimate
  // is kept.
  if (coherent) {
    const clean = cleanExposures(frequency, eMin, resultMax);
    best = closestTo(clean, target) ?? best;
    return { ...common(), kind: 'flicker', frequency, best, clean, refined: false, reference: 'coherent', explained: coherent.explained, confident: true };
  }
  // Refined at the clean value nearest the target that the sweep could measure: the dip's
  // relative width is the same at every null, so any of them pins the frequency down.
  const at = closestTo(cleanExposures(frequency, swept[0], swept[1]), target) ?? best;
  const n = Math.round(at * frequency);
  const start = at;
  let center = at;
  let half = Math.min(0.04, 0.3 / n);
  const maxHalf = 0.4 / n;
  let refined = false;
  let reference: Reference = primary.name;
  total = done + refineEstimate;
  for (let iter = 0; iter < 4; iter++) {
    const values = [
      ...new Set(Array.from({ length: 9 }, (_, i) => snapExposure(center * (1 - half + (2 * half * i) / 8), cam.exposure.step))),
    ].filter((e) => e >= cam.exposure.min && e <= cam.exposure.max);
    if (values.length < 4) break;
    // Per reference: energies of each exposure's runs.
    const runs = references.map(() => new Map<number, number[]>());
    for (const e of [...values, ...[...values].reverse()]) {
      const rec = await step('refine', e);
      if (!rec.valid) continue;
      references.forEach((r, k) => {
        const en = model.energyVsContent(rec.profile, r.w);
        runs[k].set(e, [...(runs[k].get(e) ?? []), en]);
      });
      rec.energy = model.energyVsContent(rec.profile, primary.w);
    }
    // Band amplitude falls as 1/exposure, so energy x exposure^2 makes the dip symmetric.
    const w = (e: number) => (e / center) ** 2;
    let chosen: { name: Reference; fit: NullFit; rise: number } | null = null;
    let informative = false;
    references.forEach((r, k) => {
      const pts = [...runs[k]].map(([x, ys]) => ({ x, y: (w(x) * ys.reduce((a, b) => a + b, 0)) / ys.length }));
      if (pts.length < 4) return;
      const pairs = [...runs[k]].filter(([, ys]) => ys.length === 2);
      const sigma = pairs.length ? Math.sqrt(pairs.reduce((a, [x, [u, d]]) => a + (w(x) * (u - d)) ** 2, 0) / pairs.length / 4) : 0;
      const ys = pts.map((p) => p.y);
      const rise = Math.max(ys[0], ys[ys.length - 1]) - Math.min(...ys);
      if (rise < 6 * sigma) return;
      informative = true;
      const f = nullFit(pts);
      // Cleanest reference: lowest dip floor relative to how far the edges rise.
      if (f && (!chosen || f.b / rise < chosen.fit.b / chosen.rise)) chosen = { name: r.name, fit: f, rise };
    });
    if (!informative) {
      if (half >= maxHalf) break;
      half = Math.min(maxHalf, half * 2);
      continue;
    }
    if (!chosen) break;
    const pick: { name: Reference; fit: NullFit } = chosen;
    const vertex = pick.fit.x0;
    // The coarse fit is good to a step or so; a refinement that wanders further is noise.
    if (Math.abs(vertex / center - 1) > half || Math.abs(vertex / start - 1) > MAX_REFINE_MOVE) break;
    refined = true;
    reference = pick.name;
    const moved = Math.abs(vertex / center - 1);
    center = vertex;
    frequency = n / center;
    if (moved < 0.001) break;
    half = Math.max(half / 2, (2.5 * cam.exposure.step) / center);
  }

  const clean = cleanExposures(frequency, eMin, resultMax);
  best = closestTo(clean, target) ?? center;
  const confident = refined && fit.confidence >= CONFIDENT_CONTRAST;
  return { ...common(), kind: 'flicker', frequency, best, clean, refined, reference, confident };
}

/** Even-indexed values ascending, then odd-indexed values descending. */
export function twoPass<T>(values: T[]): T[] {
  return [...values.filter((_, i) => i % 2 === 0), ...values.filter((_, i) => i % 2 === 1).reverse()];
}

function record(phase: Progress['phase'], exposure: number, iso: number | undefined, all: FrameSample[]): StepRecord {
  const frames = all.filter((f) => f.aligned !== false);
  const meanLuma = avg(frames.map((f) => f.meanLuma));
  const clipFraction = avg(frames.map((f) => f.clipFraction));
  const shifts = all.flatMap((f) => (f.shift ? [f.shift] : []));
  return {
    phase,
    exposure,
    iso,
    meanLuma,
    clipFraction,
    unaligned: all.length - frames.length,
    shift: shifts.length ? [avg(shifts.map((s) => s[0])), avg(shifts.map((s) => s[1]))] : undefined,
    valid: frames.length >= 2 && meanLuma >= MIN_LUMA && clipFraction <= MAX_CLIP,
    profile: stepProfile(exposure, frames),
  };
}

function avg(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
