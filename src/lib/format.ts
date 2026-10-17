import { shutterAngle } from './analysis';

/** 1/x seconds with one decimal, e.g. "1/48.0". Exposures of 1 s or longer as seconds. */
export function shutterText(exposure: number): string {
  if (exposure >= 1) return `${exposure.toFixed(1)} s`;
  return `1/${(1 / exposure).toFixed(1)}`;
}

export function angleText(exposure: number, fps: number): string {
  return `${shutterAngle(exposure, fps).toFixed(1)}°`;
}

export function fpsText(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, '');
}
