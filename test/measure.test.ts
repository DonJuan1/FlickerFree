import { describe, expect, it } from 'vitest';
import { measure } from '../src/lib/measure';
import { simCamera } from './sim';

describe('measure', () => {
  it('finds 1/48 (187.5 degrees at 25 fps) for a 240 Hz PWM screen', async () => {
    const r = await measure(simCamera({ sources: [{ f: 240, depth: 1, duty: 0.35 }] }), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(r.frequency / 240).toBeGreaterThan(0.997);
    expect(r.frequency / 240).toBeLessThan(1.003);
    expect(1 / r.best).toBeCloseTo(48, 0);
    // Either refined with extra steps or pinned down by the coherent model.
    expect(r.refined || r.reference === 'coherent').toBe(true);
    expect(r.clean.length).toBe(9);
  });

  it('finds 1/59.94 for a 59.94 Hz screen at 23.976 fps', async () => {
    const r = await measure(simCamera({ sources: [{ f: 59.94, depth: 0.3 }] }), { fps: 23.976 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(1 / r.best).toBeGreaterThan(59.94 * 0.997);
    expect(1 / r.best).toBeLessThan(59.94 * 1.003);
  });

  it('stays accurate when settling takes longer than the dropped frames', async () => {
    const r = await measure(simCamera({ sources: [{ f: 120, depth: 0.4 }] }, 7), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(r.frequency / 120).toBeGreaterThan(0.995);
    expect(r.frequency / 120).toBeLessThan(1.005);
  });

  it('reports no flicker for a steady screen', async () => {
    const r = await measure(simCamera({ sources: [], content: 'edges' }), { fps: 25 });
    expect(r.kind).toBe('none');
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    const cam = simCamera({ sources: [{ f: 120, depth: 0.4 }] });
    const p = measure(cam, { fps: 25, signal: ac.signal, onProgress: (pr) => pr.done > 5 && ac.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('brightness', () => {
  const pwm = { sources: [{ f: 240, depth: 1, duty: 0.35 }] };
  const sweepLuma = (r: { steps: { phase: string; meanLuma: number }[] }) => r.steps.filter((s) => s.phase === 'sweep').map((s) => s.meanLuma);

  it('holds the brightness with ISO over the whole sweep', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 0.02 }), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(1 / r.best).toBeCloseTo(48, 0);
    expect(r.limited).toEqual({ fast: false, slow: false });
    expect(r.skipped).toBe(0);
    expect(r.calibration?.isoControl).toBe(true);
    expect(Math.min(...sweepLuma(r))).toBeGreaterThan(50);
    expect(Math.max(...sweepLuma(r))).toBeLessThan(130);
  });

  it('lets a brighter screen rise where ISO reaches its minimum', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 0.1 }), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(r.limited).toEqual({ fast: false, slow: false });
    expect(r.skipped).toBe(0);
    expect(Math.max(...sweepLuma(r))).toBeGreaterThan(150);
    expect(1 / r.best).toBeCloseTo(48, 0);
  });

  it('leaves out slow shutter speeds that a bright screen would clip, and still measures', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 0.25 }), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(r.limited).toEqual({ fast: false, slow: true });
    expect(r.swept[1]).toBeLessThan(1 / 30);
    expect(r.skipped).toBe(0);
    expect(1 / r.best).toBeCloseTo(48, 0);
  });

  it('leaves out fast shutter speeds on a dark screen, and still measures', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 1e-4 }), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(r.limited).toEqual({ fast: true, slow: false });
    expect(1 / r.best).toBeCloseTo(48, 0);
  });

  it('says so when the screen is too bright for the phone', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 2 }), { fps: 25 });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('too-bright');
    expect(r.steps.length).toBeLessThanOrEqual(8);
  });

  it('says so when the screen is too dark for the phone', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 2e-5 }), { fps: 25 });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('too-dark');
  });

  it('works with exposure alone when the camera ignores ISO', async () => {
    const r = await measure(simCamera({ ...pwm, brightness: 0.05 }, 3, 1e-4, true), { fps: 25 });
    expect(r.calibration?.isoControl).toBe(false);
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(1 / r.best).toBeCloseTo(48, 0);
    expect(r.skipped).toBe(0);
  });

  it('sweeps everything when the brightness ignores the settings', async () => {
    const r = await measure(simCamera(pwm), { fps: 25 });
    expect(r.calibration?.exposureControl).toBe(false);
    expect(r.limited).toBeUndefined();
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(1 / r.best).toBeCloseTo(48, 0);
  });
});
