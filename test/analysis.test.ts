import { describe, expect, it } from 'vitest';
import {
  SweepModel,
  cleanExposures,
  closestTo,
  exposureGrid,
  fitFlicker,
  flickerEnergy,
  isFlicker,
  parabolaVertex,
  shutterAngle,
  stepProfile,
} from '../src/lib/analysis';
import { simulateFrames, type SimOptions } from './sim';

const E_MIN = 1 / 250;
const E_MAX = 1 / 20;

function sweep(opt: SimOptions, step = 0): SweepModel {
  let frame = 0;
  return new SweepModel(
    exposureGrid(E_MIN, E_MAX, 1.025, step).map((e) => {
      frame += 10;
      return stepProfile(e, simulateFrames(opt, e, 5, frame));
    }),
  );
}

describe('flickerEnergy', () => {
  it('is near zero at a clean exposure and large between nulls', () => {
    const opt: SimOptions = { sources: [{ f: 120, depth: 0.5 }], content: 'flat' };
    const clean = flickerEnergy(simulateFrames(opt, 1 / 60, 5));
    const dirty = flickerEnergy(simulateFrames(opt, 1 / 80, 5));
    expect(Math.sqrt(Math.max(0, clean))).toBeLessThan(0.002);
    expect(Math.sqrt(dirty)).toBeGreaterThan(0.01);
  });
});

describe('SweepModel', () => {
  it('cancels static content: two clean steps are ~identical', () => {
    const opt: SimOptions = { sources: [{ f: 120, depth: 0.5 }], content: 'smooth', seed: 9 };
    const a = stepProfile(1 / 60, simulateFrames(opt, 1 / 60, 5, 0));
    const b = stepProfile(1 / 30, simulateFrames(opt, 1 / 30, 5, 50));
    const c = stepProfile(1 / 80, simulateFrames(opt, 1 / 80, 5, 100));
    const m = new SweepModel([a, b, c]);
    expect(Math.abs(m.dist(1 / 60, 1 / 30))).toBeLessThan(1e-6);
    expect(m.dist(1 / 60, 1 / 80)).toBeGreaterThan(1e-5);
  });
});

describe('fitFlicker', () => {
  const cases: [string, SimOptions, number][] = [
    ['50 Hz', { sources: [{ f: 50, depth: 0.3 }] }, 50],
    ['60 Hz refresh, sine', { sources: [{ f: 60, depth: 0.3 }] }, 60],
    ['59.94 Hz', { sources: [{ f: 59.94, depth: 0.3 }] }, 59.94],
    ['100 Hz', { sources: [{ f: 100, depth: 0.4 }] }, 100],
    ['120 Hz', { sources: [{ f: 120, depth: 0.4 }] }, 120],
    ['144 Hz', { sources: [{ f: 144, depth: 0.4 }] }, 144],
    ['240 Hz PWM 30% duty', { sources: [{ f: 240, depth: 1, duty: 0.3 }] }, 240],
    ['480 Hz PWM', { sources: [{ f: 480, depth: 1, duty: 0.5 }] }, 480],
    ['1000 Hz PWM', { sources: [{ f: 1000, depth: 1, duty: 0.5 }] }, 1000],
    ['PWM 240 + refresh 60', { sources: [{ f: 240, depth: 0.8, duty: 0.4 }, { f: 60, depth: 0.1 }] }, 60],
    ['240 Hz with full-width content edges', { sources: [{ f: 240, depth: 1, duty: 0.4 }], content: 'edges' }, 240],
    ['120 Hz, bands locked to 30 fps', { sources: [{ f: 120, depth: 0.4 }], cameraFps: 30 }, 120],
    ['60 Hz, weak (5%) under strong content', { sources: [{ f: 60, depth: 0.05 }], content: 'edges', seed: 4 }, 60],
  ];

  for (const [name, opt, expected] of cases) {
    it(`finds ${name}`, () => {
      const fit = fitFlicker(sweep(opt));
      expect(isFlicker(fit)).toBe(true);
      expect(fit!.frequency / expected).toBeGreaterThan(0.99);
      expect(fit!.frequency / expected).toBeLessThan(1.01);
    });
  }

  it('reports no flicker for a steady screen', () => {
    for (const content of ['flat', 'smooth', 'edges'] as const) {
      for (const seed of [1, 2, 3]) {
        expect(isFlicker(fitFlicker(sweep({ sources: [], content, seed })))).toBe(false);
      }
    }
  });

  it('works with 100 microsecond exposure steps', () => {
    const fit = fitFlicker(sweep({ sources: [{ f: 240, depth: 1, duty: 0.4 }] }, 1e-4));
    expect(fit!.frequency / 240).toBeGreaterThan(0.99);
    expect(fit!.frequency / 240).toBeLessThan(1.01);
  });
});

describe('clean values', () => {
  it('lists n / f within range and picks the one closest to 180 degrees', () => {
    const clean = cleanExposures(240, E_MIN, 1 / 25);
    expect(clean[0]).toBeCloseTo(1 / 240, 9);
    expect(clean.at(-1)).toBeCloseTo(9 / 240, 9);
    expect(closestTo(clean, 1 / 50)).toBeCloseTo(1 / 48, 9);
    expect(shutterAngle(1 / 48, 25)).toBeCloseTo(187.5, 6);
  });
});

describe('parabolaVertex', () => {
  it('finds the minimum of a noisy parabola', () => {
    const pts = Array.from({ length: 9 }, (_, i) => {
      const x = 0.019 + i * 0.00025;
      return { x, y: 3 * (x - 0.02013) ** 2 + 1e-6 + (i % 2 ? 1e-9 : -1e-9) };
    });
    expect(parabolaVertex(pts)!).toBeCloseTo(0.02013, 5);
  });

  it('rejects a downward parabola', () => {
    expect(parabolaVertex([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }])).toBeNull();
  });
});
