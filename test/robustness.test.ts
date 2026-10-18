import { describe, expect, it } from 'vitest';
import { cleanExposures, closestTo } from '../src/lib/analysis';
import { measure } from '../src/lib/measure';
import { simCamera, type SimOptions } from './sim';

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

// Screens that scan their rows (OLED) tilt the bands; the camera reads out across them.
const tilted: [string, SimOptions, number, number][] = [
  // Measured from a real recording: OnePlus 7T OLED (90 Hz refresh, short dark dip each
  // refresh, ~15% darker at 1/2000 after gamma), bands at ~38 degrees, drifting ~2.8% of a
  // period per frame at 30 fps.
  ['OLED 90 Hz refresh dip, rolling slowly', { sources: [{ f: 90.83, depth: 1, duty: 0.985 }], readout: 0.0046, scan: 0.0065, cameraFps: 30, content: 'edges', noise: 0.3 }, 25, 0.003],
  ['OLED 90 Hz refresh dip, standing', { sources: [{ f: 90, depth: 1, duty: 0.985 }], readout: 0.0046, scan: 0.0065, cameraFps: 30, content: 'edges', noise: 0.3 }, 25, 0.003],
  ['OLED 90 Hz refresh dip, drifting (clock mismatch)', { sources: [{ f: 90, depth: 1, duty: 0.985 }], readout: 0.0046, scan: 0.0065, cameraFps: 30.002, content: 'edges', noise: 0.3 }, 25, 0.003],
  ['60 Hz, drifting slowly (clock mismatch)', { sources: [{ f: 60, depth: 0.3 }], readout: 0.0046, scan: 0.0065, cameraFps: 30.002, content: 'edges', noise: 0.3 }, 25, 0.003],
  ['240 Hz PWM at 45 degrees', { sources: [{ f: 240, depth: 1, duty: 0.3 }], readout: 0.006, scan: 0.006, cameraFps: 30, content: 'smooth', noise: 0.3 }, 25, 0.003],
  ['480 Hz PWM at 60 degrees', { sources: [{ f: 480, depth: 1, duty: 0.5 }], readout: 0.004, scan: 0.007, cameraFps: 30.01, content: 'edges', noise: 0.3 }, 24, 0.003],
  ['60 Hz dip, bands across the readout', { sources: [{ f: 60, depth: 1, duty: 0.99 }], readout: 0.0005, scan: 0.012, cameraFps: 30.02, content: 'edges', noise: 0.3 }, 25, 0.005],
];

describe('tilted bands', () => {
  // Camera keeping its brightness constant, and one following exposure x ISO (calibrated).
  for (const [name, base, fps, tol] of tilted) {
    for (const opt of [base, { ...base, brightness: 0.05 }]) {
      it(`${name}${opt.brightness ? ', calibrated brightness' : ''}`, async () => {
        const f = opt.sources[0].f;
        const r = await measure(simCamera(opt, 4), { fps });
        const want = closestTo(cleanExposures(f, 1 / 250, 1 / fps), 1 / (2 * fps))!;
        expect(r.kind).toBe('flicker');
        if (r.kind !== 'flicker') return;
        expect(Math.abs(r.best / want - 1)).toBeLessThan(tol);
        expect(r.confident).toBe(true);
      });
    }
  }

  it('reports no flicker for steady screens', async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const opt: SimOptions = { sources: [], content: (['flat', 'smooth', 'edges'] as const)[seed % 3], seed, noise: [0.1, 0.3, 1, 2][seed % 4], readout: 0.005, scan: 0.006, brightness: seed % 2 ? 0.05 : undefined };
      expect((await measure(simCamera(opt, 4), { fps: 25 })).kind).toBe('none');
    }
  }, 60000);
});

describe('measure robustness', () => {
  for (const [f, extra, fps] of cases) {
    const { duty, ...rest } = extra as Partial<SimOptions> & { duty?: number };
    it(`${f} Hz${duty ? ` PWM ${duty}` : ''}, phone ${rest.cameraFps} fps, ${rest.content}, project ${fps} fps`, async () => {
      const opt: SimOptions = { sources: [{ f, depth: duty ? 1 : 0.3, duty }], readout: 0.024, noise: 0.3, seed: f, ...rest };
      const r = await measure(simCamera(opt, 4), { fps });
      const want = closestTo(cleanExposures(f, 1 / 250, 1 / fps), 1 / (2 * fps))!;
      expect(r.kind).toBe('flicker');
      if (r.kind !== 'flicker') return;
      expect(Math.abs(r.best / want - 1)).toBeLessThan(0.003);
    });
  }
});
