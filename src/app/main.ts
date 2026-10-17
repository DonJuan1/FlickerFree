import { Camera, REGION } from '../lib/camera';
import { angleText, fpsText, shutterText } from '../lib/format';
import { measure, type MeasureResult, type Progress } from '../lib/measure';

const APP_VERSION = 2;
const FPS_KEY = 'flickerfree.fps';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const regionEl = $('region');
const cameraMsg = $('cameraMsg');
const fpsSel = $<HTMLSelectElement>('fps');
const measureBtn = $<HTMLButtonElement>('measure');
const stopBtn = $<HTMLButtonElement>('stop');
const progressEl = $('progress');
const barEl = $('bar');
const phaseEl = $('phase');
const resultEl = $('result');
const errorEl = $('error');
const diagStatus = $('diagStatus');

let camera: Camera | null = null;
let abort: AbortController | null = null;
let last: { result: MeasureResult; fps: number; at: string; ms: number } | null = null;

// ---------- setup ----------

try {
  const saved = localStorage.getItem(FPS_KEY);
  if (saved && [...fpsSel.options].some((o) => o.value === saved)) fpsSel.value = saved;
} catch {
  // Storage unavailable (private mode): keep the default.
}
fpsSel.addEventListener('change', () => {
  try {
    localStorage.setItem(FPS_KEY, fpsSel.value);
  } catch {
    // ignore
  }
});

void start();

async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return unsupported('The camera is only available over HTTPS in a browser that supports it.');
  }
  try {
    camera = await Camera.open(video);
  } catch (e) {
    cameraMsg.textContent = 'Camera unavailable.';
    showError(`Could not open the camera (${e instanceof Error ? e.message : String(e)}). Allow camera access and reload.`);
    return;
  }
  cameraMsg.hidden = true;
  placeRegion();
  video.addEventListener('resize', placeRegion);
  if (!camera.manualExposure) {
    return unsupported(
      'This phone or browser does not allow manual exposure control from a web page. FlickerFree needs Chrome on an Android phone whose camera supports it.',
    );
  }
  measureBtn.disabled = false;
}

function unsupported(msg: string) {
  if (!camera) cameraMsg.textContent = 'Camera not available.';
  showError(`Not supported. ${msg}`);
  measureBtn.disabled = true;
}

/** Outline the analysed area: readout axis = the frame's short side. */
function placeRegion() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const landscape = vw >= vh;
  const w = landscape ? REGION.long : REGION.readout;
  const h = landscape ? REGION.readout : REGION.long;
  Object.assign(regionEl.style, { left: `${((1 - w) / 2) * 100}%`, width: `${w * 100}%`, top: `${((1 - h) / 2) * 100}%`, height: `${h * 100}%` });
  // Keep the stage at the video's aspect ratio, also when its height is capped, so the
  // outline (in % of the stage) lines up with the picture.
  const stage = $('stage');
  stage.style.aspectRatio = `${vw} / ${vh}`;
  stage.style.width = `min(100%, calc(62vh * ${vw / vh}))`;
  regionEl.hidden = false;
}

// ---------- measurement ----------

measureBtn.addEventListener('click', () => void run());
stopBtn.addEventListener('click', () => abort?.abort());

async function run() {
  if (!camera) return;
  const fps = Number(fpsSel.value);
  abort = new AbortController();
  measureBtn.disabled = true;
  fpsSel.disabled = true;
  resultEl.hidden = true;
  errorEl.hidden = true;
  progressEl.hidden = false;
  showProgress({ phase: 'calibrate', done: 0, total: 1 });
  const lock = await wakeLock();
  const t0 = performance.now();
  try {
    const result = await measure(camera, { fps, signal: abort.signal, onProgress: showProgress });
    last = { result, fps, at: new Date().toISOString(), ms: Math.round(performance.now() - t0) };
    showResult(result, fps);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') showError('Measurement stopped.');
    else showError(`Measurement failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    progressEl.hidden = true;
    measureBtn.disabled = false;
    fpsSel.disabled = false;
    void lock?.release().catch(() => {});
    await camera.auto().catch(() => {});
  }
}

async function wakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

function showProgress(p: Progress) {
  barEl.style.width = `${Math.min(100, (100 * p.done) / Math.max(1, p.total))}%`;
  const at = p.exposure ? ` ${shutterText(p.exposure)}` : '';
  phaseEl.textContent = {
    calibrate: 'Setting brightness...',
    sweep: `Sweeping${at}`,
    analyse: 'Analysing...',
    refine: `Refining around${at}`,
  }[p.phase];
}

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function showResult(r: MeasureResult, fps: number) {
  resultEl.replaceChildren();
  const [eMin, eMax] = r.range;
  const rangeText = `${shutterText(eMin)} to ${shutterText(eMax)} (${angleText(eMax, fps)})`;
  const el = (tag: string, cls: string, text: string) => Object.assign(document.createElement(tag), { className: cls, textContent: text });

  if (r.kind === 'error') {
    showError(r.message);
    return;
  }
  if (r.kind === 'none') {
    resultEl.append(el('div', 'headline', 'No flicker detected'), el('p', 'muted', `Every shutter speed from ${rangeText} at ${fpsText(fps)} fps works.`));
  } else if (r.kind === 'no-clean') {
    resultEl.append(
      el('div', 'headline', 'No clean shutter speed'),
      el('p', 'muted', `The screen flickers at ${r.frequency.toFixed(1)} Hz; no shutter speed from ${rangeText} removes it.`),
    );
  } else {
    resultEl.append(
      el('div', 'speed', `${shutterText(r.best)} s`),
      el('div', 'angle', `${angleText(r.best, fps)} at ${fpsText(fps)} fps`),
      el('p', 'muted small', `Screen flicker: ${r.frequency.toFixed(2)} Hz${r.refined ? '' : ' (not refined)'}`),
    );
    const others = r.clean.filter((e) => e !== r.best);
    if (others.length) {
      resultEl.append(el('h2', '', 'Other clean values'));
      const table = document.createElement('table');
      table.className = 'values';
      for (const e of others) {
        const tr = table.insertRow();
        tr.insertCell().textContent = `${shutterText(e)} s`;
        tr.insertCell().textContent = angleText(e, fps);
      }
      resultEl.append(table);
    }
  }
  if (r.skipped) {
    resultEl.append(el('p', 'muted small', `${r.skipped} step${r.skipped > 1 ? 's were' : ' was'} too bright or too dark and skipped.`));
  }
  resultEl.hidden = false;
}

// ---------- diagnostics ----------

function report(full: boolean) {
  const r = last?.result;
  const round = (v: number | undefined, d = 6) => (v === undefined ? null : +v.toPrecision(d));
  return {
    app: 'FlickerFree',
    version: APP_VERSION,
    at: last?.at ?? new Date().toISOString(),
    durationMs: last?.ms,
    userAgent: navigator.userAgent,
    fps: last?.fps,
    caps: camera && {
      exposureMode: camera.caps.exposureMode,
      exposureTime: camera.caps.exposureTime,
      iso: camera.caps.iso,
      frameRate: camera.caps.frameRate,
      width: camera.caps.width,
      height: camera.caps.height,
    },
    video: { w: video.videoWidth, h: video.videoHeight },
    result: r && {
      kind: r.kind,
      frequency: 'frequency' in r ? round(r.frequency, 8) : null,
      best: 'best' in r ? round(r.best, 8) : null,
      clean: 'clean' in r ? r.clean.map((e) => round(e, 8)) : null,
      refined: 'refined' in r ? r.refined : null,
      message: 'message' in r ? r.message : null,
      range: r.range,
      swept: r.swept,
      skipped: r.skipped,
      fit: r.fit && { ...r.fit, anchors: r.fit.anchors.map((a) => round(a, 6)) },
    },
    // phase, exposure (s), iso, mean luma, clip fraction, valid, band energy, self covariance
    steps: r?.steps.map((s) => [
      s.phase[0],
      round(s.exposure),
      s.iso ?? null,
      round(s.meanLuma, 4),
      round(s.clipFraction, 3),
      s.valid ? 1 : 0,
      round(s.energy, 4),
      round(s.profile.selfCov, 4),
      ...(full ? [s.profile.times.map((t) => round(t, 9)), s.profile.mean.map((m) => downsample(m, 96).map((v) => round(v, 4)))] : []),
    ]),
  };
}

function downsample(a: Float64Array, n: number): number[] {
  if (a.length <= n) return [...a];
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i * a.length) / n);
    const to = Math.floor(((i + 1) * a.length) / n);
    let s = 0;
    for (let k = from; k < to; k++) s += a[k];
    return s / (to - from);
  });
}

$('copyDiag').addEventListener('click', async () => {
  const text = JSON.stringify(report(false));
  try {
    await navigator.clipboard.writeText(text);
    diagStatus.textContent = `Copied (${Math.round(text.length / 1024)} kB).`;
  } catch {
    diagStatus.textContent = text;
    getSelection()?.selectAllChildren(diagStatus);
  }
});

$('downloadDiag').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(report(true))], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `flickerfree-${Date.now()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
