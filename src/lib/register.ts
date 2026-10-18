// Frame registration: estimates the translation between a frame and a reference frame
// by phase correlation, so hand shake doesn't leave screen content (text edges) behind
// in the comparison between exposure steps. Flicker bands are smooth, so the high-pass
// before correlating keeps them from steering the estimate.

/** In-place iterative radix-2 complex FFT. `inverse` computes the unscaled inverse. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** 2D FFT of a w x h (powers of two) complex image stored row-major. */
function fft2(re: Float64Array, im: Float64Array, w: number, h: number, inverse = false): void {
  const rr = new Float64Array(w);
  const ri = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    rr.set(re.subarray(y * w, (y + 1) * w));
    ri.set(im.subarray(y * w, (y + 1) * w));
    fft(rr, ri, inverse);
    re.set(rr, y * w);
    im.set(ri, y * w);
  }
  const cr = new Float64Array(h);
  const ci = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      cr[y] = re[y * w + x];
      ci[y] = im[y * w + x];
    }
    fft(cr, ci, inverse);
    for (let y = 0; y < h; y++) {
      re[y * w + x] = cr[y];
      im[y * w + x] = ci[y];
    }
  }
}

function largestPow2(n: number): number {
  return 1 << Math.floor(Math.log2(n));
}

export interface Shift {
  /** Offset of the frame relative to the reference: frame(x + dx, y + dy) ~ reference(x, y). */
  dx: number;
  dy: number;
  /** Normalised correlation peak (0..1); low values mean the estimate is unreliable. */
  peak: number;
}

/**
 * Phase-correlation registration on the central power-of-two crop of a log-luma image.
 * The crop is high-passed (box blur subtracted) and Hann-windowed before the FFT.
 */
export class Registrar {
  readonly cw: number;
  readonly ch: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly window: Float64Array;
  private ref: { re: Float64Array; im: Float64Array } | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly blur = 5,
  ) {
    this.cw = Math.min(256, largestPow2(width));
    this.ch = Math.min(256, largestPow2(height));
    this.x0 = (width - this.cw) >> 1;
    this.y0 = (height - this.ch) >> 1;
    this.window = new Float64Array(this.cw * this.ch);
    for (let y = 0; y < this.ch; y++) {
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / this.ch);
      for (let x = 0; x < this.cw; x++) {
        this.window[y * this.cw + x] = wy * (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / this.cw));
      }
    }
  }

  get hasReference(): boolean {
    return this.ref !== null;
  }

  clear() {
    this.ref = null;
  }

  setReference(logImage: ArrayLike<number>) {
    this.ref = this.spectrum(logImage);
  }

  estimate(logImage: ArrayLike<number>): Shift {
    if (!this.ref) throw new Error('No reference frame');
    const cur = this.spectrum(logImage);
    const { re: rr, im: ri } = this.ref;
    const n = this.cw * this.ch;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    // Normalised cross-power spectrum: cur * conj(ref) / |cur * conj(ref)|
    for (let i = 0; i < n; i++) {
      const a = cur.re[i] * rr[i] + cur.im[i] * ri[i];
      const b = cur.im[i] * rr[i] - cur.re[i] * ri[i];
      const m = Math.hypot(a, b) + 1e-12;
      re[i] = a / m;
      im[i] = b / m;
    }
    fft2(re, im, this.cw, this.ch, true);
    let best = 0;
    for (let i = 1; i < n; i++) if (re[i] > re[best]) best = i;
    const by = Math.floor(best / this.cw);
    const bx = best % this.cw;
    const at = (x: number, y: number) => re[((y + this.ch) % this.ch) * this.cw + ((x + this.cw) % this.cw)];
    const sub = (m: number, c: number, p: number) => {
      const d = m - 2 * c + p;
      return d < 0 ? (m - p) / (2 * d) : 0;
    };
    let dx = bx + sub(at(bx - 1, by), at(bx, by), at(bx + 1, by));
    let dy = by + sub(at(bx, by - 1), at(bx, by), at(bx, by + 1));
    if (dx > this.cw / 2) dx -= this.cw;
    if (dy > this.ch / 2) dy -= this.ch;
    return { dx, dy, peak: re[best] / n };
  }

  private spectrum(img: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
    const { cw, ch, x0, y0, width } = this;
    const k = this.blur;
    const r = k >> 1;
    const crop = new Float64Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = img[(y + y0) * width + x + x0];
    // Box blur via a summed-area table (clamped edges), then high-pass = crop - blur.
    const sat = new Float64Array((cw + 1) * (ch + 1));
    for (let y = 0; y < ch; y++) {
      let row = 0;
      for (let x = 0; x < cw; x++) {
        row += crop[y * cw + x];
        sat[(y + 1) * (cw + 1) + x + 1] = sat[y * (cw + 1) + x + 1] + row;
      }
    }
    const re = new Float64Array(cw * ch);
    const im = new Float64Array(cw * ch);
    let mean = 0;
    for (let y = 0; y < ch; y++) {
      const ya = Math.max(0, y - r);
      const yb = Math.min(ch, y + r + 1);
      for (let x = 0; x < cw; x++) {
        const xa = Math.max(0, x - r);
        const xb = Math.min(cw, x + r + 1);
        const s = sat[yb * (cw + 1) + xb] - sat[ya * (cw + 1) + xb] - sat[yb * (cw + 1) + xa] + sat[ya * (cw + 1) + xa];
        const v = crop[y * cw + x] - s / ((yb - ya) * (xb - xa));
        re[y * cw + x] = v;
        mean += v;
      }
    }
    mean /= cw * ch;
    for (let i = 0; i < re.length; i++) re[i] = (re[i] - mean) * this.window[i];
    fft2(re, im, cw, ch);
    return { re, im };
  }
}

/** Bilinear sample of a w x h image at (x, y); NaN outside. */
export function bilinear(img: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.min(w - 2, Math.floor(x));
  const y0 = Math.min(h - 2, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * w + x0;
  return (1 - ty) * ((1 - tx) * img[i] + tx * img[i + 1]) + ty * ((1 - tx) * img[i + w] + tx * img[i + w + 1]);
}
