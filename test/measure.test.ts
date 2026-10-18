import { describe, expect, it } from 'vitest';
import { measure, type MeasureCamera } from '../src/lib/measure';
import { simulateFrames, type SimOptions } from './sim';

/** Camera backed by the simulator. `lag` frames after a change still show the old exposure. */
function fakeCamera(opt: SimOptions, lag = 3, step = 1e-4): MeasureCamera & { calls: number } {
  let frame = 0;
  let current = 1 / 100;
  let previous = current;
  return {
    calls: 0,
    exposure: { min: 1e-4, max: 0.5, step },
    iso: { min: 100, max: 3200, step: 1 },
    async setExposure(e) {
      previous = current;
      current = e;
      this.calls++;
    },
    async capture(discard, count) {
      const out = [];
      for (let i = 0; i < discard + count; i++) {
        const e = i < lag ? previous : current;
        const [f] = simulateFrames(opt, e, 1, frame++);
        if (i >= discard) out.push(f);
      }
      return out;
    },
  };
}

describe('measure', () => {
  it('finds 1/48 (187.5 degrees at 25 fps) for a 240 Hz PWM screen', async () => {
    const r = await measure(fakeCamera({ sources: [{ f: 240, depth: 1, duty: 0.35 }] }), { fps: 25 });
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
    const r = await measure(fakeCamera({ sources: [{ f: 59.94, depth: 0.3 }] }), { fps: 23.976 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(1 / r.best).toBeGreaterThan(59.94 * 0.997);
    expect(1 / r.best).toBeLessThan(59.94 * 1.003);
  });

  it('stays accurate when settling takes longer than the dropped frames', async () => {
    const r = await measure(fakeCamera({ sources: [{ f: 120, depth: 0.4 }] }, 7), { fps: 25 });
    expect(r.kind).toBe('flicker');
    if (r.kind !== 'flicker') return;
    expect(r.frequency / 120).toBeGreaterThan(0.995);
    expect(r.frequency / 120).toBeLessThan(1.005);
  });

  it('reports no flicker for a steady screen', async () => {
    const r = await measure(fakeCamera({ sources: [], content: 'edges' }), { fps: 25 });
    expect(r.kind).toBe('none');
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    const cam = fakeCamera({ sources: [{ f: 120, depth: 0.4 }] });
    const p = measure(cam, { fps: 25, signal: ac.signal, onProgress: (pr) => pr.done > 5 && ac.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
