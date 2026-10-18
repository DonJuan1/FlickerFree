import { describe, expect, it } from 'vitest';
import { Registrar, bilinear, fft } from '../src/lib/register';

/** Text-like test image: random dark glyph boxes and lines on a light background, in log luma. */
function makeScene(w: number, h: number, seed = 1): Float64Array {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const img = new Float64Array(w * h).fill(200);
  for (let k = 0; k < 400; k++) {
    const x = Math.floor(rnd() * w);
    const y = Math.floor(rnd() * h);
    const bw = 1 + Math.floor(rnd() * 6);
    const bh = 2 + Math.floor(rnd() * 8);
    for (let yy = y; yy < Math.min(h, y + bh); yy++) for (let xx = x; xx < Math.min(w, x + bw); xx++) img[yy * w + xx] = 40;
  }
  return img;
}

/** Scene shifted by (dx, dy) (content moves by +d), with an optional tilted band and gain. */
function shifted(scene: Float64Array, w: number, h: number, dx: number, dy: number, band = 0, gain = 1): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = bilinear(scene, w, h, Math.min(w - 1, Math.max(0, x - dx)), Math.min(h - 1, Math.max(0, y - dy)));
      const b = 1 + band * Math.sin((2 * Math.PI * (0.8 * x + 0.6 * y)) / 120);
      out[y * w + x] = Math.log(v * b * gain);
    }
  }
  return out;
}

describe('fft', () => {
  it('round-trips', () => {
    const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i) + i * 0.1);
    const im = new Float64Array(16);
    const orig = [...re];
    fft(re, im);
    fft(re, im, true);
    re.forEach((v, i) => expect(v / 16).toBeCloseTo(orig[i], 10));
  });
});

describe('Registrar', () => {
  const w = 180;
  const h = 320;
  const scene = makeScene(w, h);

  it('recovers sub-pixel shifts', () => {
    const reg = new Registrar(w, h);
    reg.setReference(shifted(scene, w, h, 0, 0));
    for (const [dx, dy] of [[0, 0], [3.4, -2.2], [-7.7, 5.5], [12.3, 9.1]]) {
      const s = reg.estimate(shifted(scene, w, h, dx, dy));
      expect(s.dx).toBeCloseTo(dx, 0);
      expect(s.dy).toBeCloseTo(dy, 0);
      expect(Math.abs(s.dx - dx)).toBeLessThan(0.3);
      expect(Math.abs(s.dy - dy)).toBeLessThan(0.3);
    }
  });

  it('is not steered by flicker bands or a brightness change', () => {
    const reg = new Registrar(w, h);
    reg.setReference(shifted(scene, w, h, 0, 0, 0.3));
    const s = reg.estimate(shifted(scene, w, h, 4.5, -3.25, 0.3, 0.6));
    expect(Math.abs(s.dx - 4.5)).toBeLessThan(0.3);
    expect(Math.abs(s.dy + 3.25)).toBeLessThan(0.3);
  });
});
