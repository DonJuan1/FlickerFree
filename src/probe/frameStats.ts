export interface FrameStats {
  /** Mean luma (0-255) over the centre region. */
  meanLuma: number;
  /** Mean luma per image row, centre columns only. Length = region height. */
  rowProfile: Float32Array;
  /** Mean luma per image column, centre rows only. Length = region width. */
  colProfile: Float32Array;
  /** RMS of the linearly detrended row profile, relative to its mean. */
  rowBand: number;
  /** Same for the column profile. */
  colBand: number;
}

/** Fraction of each image axis (centred) that is analysed. */
const REGION = 0.8;

export function analyzeFrame(data: Uint8ClampedArray, width: number, height: number): FrameStats {
  const x0 = Math.floor((width * (1 - REGION)) / 2);
  const y0 = Math.floor((height * (1 - REGION)) / 2);
  const w = width - 2 * x0;
  const h = height - 2 * y0;
  const rowSum = new Float64Array(h);
  const colSum = new Float64Array(w);
  let total = 0;

  for (let y = 0; y < h; y++) {
    let i = ((y + y0) * width + x0) * 4;
    let acc = 0;
    for (let x = 0; x < w; x++, i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      acc += luma;
      colSum[x] += luma;
    }
    rowSum[y] = acc;
    total += acc;
  }

  const rowProfile = new Float32Array(h);
  const colProfile = new Float32Array(w);
  for (let y = 0; y < h; y++) rowProfile[y] = rowSum[y] / w;
  for (let x = 0; x < w; x++) colProfile[x] = colSum[x] / h;

  return {
    meanLuma: total / (w * h),
    rowProfile,
    colProfile,
    rowBand: relativeDetrendedRms(rowProfile),
    colBand: relativeDetrendedRms(colProfile),
  };
}

/** Profile minus its least-squares line, divided by its mean. */
export function detrendRelative(p: Float32Array): Float32Array {
  const n = p.length;
  const out = new Float32Array(n);
  if (n < 2) return out;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += p[i];
    sxx += i * i;
    sxy += i * p[i];
  }
  const mean = sy / n;
  if (mean <= 0) return out;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) out[i] = (p[i] - (intercept + slope * i)) / mean;
  return out;
}

function relativeDetrendedRms(p: Float32Array): number {
  const d = detrendRelative(p);
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  return d.length ? Math.sqrt(s / d.length) : 0;
}
