import { describe, expect, it } from 'vitest';
import { cleanExposures, closestTo } from '../src/lib/analysis';
import { measure, type MeasureCamera } from '../src/lib/measure';
import { simulateFrames, type SimOptions } from './sim';

/** Simulated camera; the first `lag` frames after a change still show the old exposure. */
function camera(opt: SimOptions, lag: number): MeasureCamera {
  let frame = 0;
  let current = 0.01;
  let previous = current;
  return {
    exposure: { min: 1e-4, max: 0.5, step: 1e-4 },
    iso: { min: 100, max: 3200, step: 1 },
    async setExposure(e) {
      previous = current;
      current = e;
    },
    async capture(discard, count) {
      const out = [];
      for (let i = 0; i < discard + count; i++) {
        const [f] = simulateFrames(opt, i < lag ? previous : current, 1, frame++);
        if (i >= discard) out.push(f);
      }
      return out;
    },
  };
}

// Screens x phone timing x content x project fps, including bands locked to the phone's
// frame rate (30 fps vs 60/120/240 Hz) and rolling ones.
const cases: [number, Partial<SimOptions>, number][] = [
  [60, { cameraFps: 30, content: 'smooth' }, 25],
  [59.94, { cameraFps: 30.02, content: 'edges' }, 23.976],
  [100, { cameraFps: 29.97, content: 'flat' }, 25],
  [120, { cameraFps: 30, content: 'edges' }, 24],
  [144, { cameraFps: 24, content: 'smooth' }, 29.97],
  [240, { cameraFps: 30, content: 'smooth', duty: 0.35 } as Partial<SimOptions>, 25],
  [240, { cameraFps: 30.5, content: 'edges', duty: 0.2 } as Partial<SimOptions>, 50],
  [480, { cameraFps: 15, content: 'flat', duty: 0.5 } as Partial<SimOptions>, 25],
];

describe('measure robustness', () => {
  for (const [f, extra, fps] of cases) {
    const { duty, ...rest } = extra as Partial<SimOptions> & { duty?: number };
    it(`${f} Hz${duty ? ` PWM ${duty}` : ''}, phone ${rest.cameraFps} fps, ${rest.content}, project ${fps} fps`, async () => {
      const opt: SimOptions = { sources: [{ f, depth: duty ? 1 : 0.3, duty }], readout: 0.024, noise: 0.3, seed: f, ...rest };
      const r = await measure(camera(opt, 4), { fps });
      const want = closestTo(cleanExposures(f, 1 / 250, 1 / fps), 1 / (2 * fps))!;
      expect(r.kind).toBe('flicker');
      if (r.kind !== 'flicker') return;
      expect(Math.abs(r.best / want - 1)).toBeLessThan(0.003);
    });
  }
});
