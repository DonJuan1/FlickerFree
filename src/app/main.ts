import { Camera, REGION } from '../lib/camera';
import { angleText, fpsText, shutterText } from '../lib/format';
import { measure, type MeasureResult, type Progress } from '../lib/measure';

const APP_VERSION = 5;
const FPS_KEY = 'flickerfree.fps';
const CAMERA_KEY = 'flickerfree.camera';
/** Grey test image to show on the measured screen. */
const TARGET = new URL('./target.html', location.href);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const regionEl = $('region');
const cameraMsg = $('cameraMsg');
const fpsSel = $<HTMLSelectElement>('fps');
const lensRow = $('lensRow');
const lensSel = $<HTMLSelectElement>('lens');
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

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage unavailable (private mode): keep the default.
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

const savedFps = stored(FPS_KEY);
if (savedFps && [...fpsSel.options].some((o) => o.value === savedFps)) fpsSel.value = savedFps;
fpsSel.addEventListener('change', () => store(FPS_KEY, fpsSel.value));
video.addEventListener('resize', placeRegion);

// Another back camera (lens) on request, remembered; the main camera by default.
lensSel.addEventListener('change', async () => {
  store(CAMERA_KEY, lensSel.value);
  measureBtn.disabled = true;
  lensSel.disabled = true;
  camera?.stop();
  camera = null;
  regionEl.hidden = true;
  await start();
  lensSel.disabled = false;
});

void start();

async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return unsupported('The camera is only available over HTTPS in a browser that supports it.');
  }
  errorEl.hidden = true;
  cameraMsg.textContent = 'Starting camera...';
  cameraMsg.hidden = false;
  try {
    camera = await Camera.open(video, stored(CAMERA_KEY));
  } catch (e) {
    cameraMsg.textContent = 'Camera unavailable.';
    showError(`Could not open the camera (${e instanceof Error ? e.message : String(e)}). Allow camera access and reload.`);
    return;
  }
  cameraMsg.hidden = true;
  placeRegion();
  showLenses(camera);
  if (!camera.manualExposure) {
    return unsupported(
      'This phone or browser does not allow manual exposure control from a web page. FlickerFree needs Chrome on an Android phone whose camera supports it.',
    );
  }
  measureBtn.disabled = false;
}

function showLenses(cam: Camera) {
  lensSel.replaceChildren(...cam.cameras.map((c, i) => new Option(i === 0 ? 'Main camera' : `Back camera ${i + 1}`, c.deviceId)));
  lensSel.value = cam.deviceId ?? '';
  lensRow.hidden = cam.cameras.length < 2;
}

function unsupported(msg: string) {
  if (!camera) cameraMsg.textContent = 'Camera not available.';
  showError(`Not supported. ${msg}`);
  measureBtn.disabled = true;
}

/** Outline the analysed area (centred; the rest of the frame is margin for hand shake). */
function placeRegion() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const m = `${((1 - REGION) / 2) * 100}%`;
  const size = `${REGION * 100}%`;
  Object.assign(regionEl.style, { left: m, width: size, top: m, height: size });
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
  lensSel.disabled = true;
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
    lensSel.disabled = false;
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

function showError(msg: string, withTarget = false) {
  errorEl.replaceChildren(msg);
  if (withTarget) errorEl.append(targetLink());
  errorEl.hidden = false;
}

function targetLink(): HTMLElement {
  const p = Object.assign(document.createElement('p'), { className: 'small' });
  const a = Object.assign(document.createElement('a'), { href: TARGET.href, target: '_blank', textContent: TARGET.host + TARGET.pathname });
  p.append('Grey test image to open on the screen: ', a);
  return p;
}

function showResult(r: MeasureResult, fps: number) {
  resultEl.replaceChildren();
  const [eMin, eMax] = r.range;
  const rangeText = `${shutterText(eMin)} to ${shutterText(eMax)} (${angleText(eMax, fps)})`;
  const el = (tag: string, cls: string, text: string) => Object.assign(document.createElement(tag), { className: cls, textContent: text });

  if (r.kind === 'error') {
    showError(r.message, r.reason === 'too-bright' || r.reason === 'too-dark' || r.reason === 'exposure');
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
    if (!r.confident) {
      resultEl.append(
        el('div', 'headline', 'Flicker found, frequency unclear'),
        el(
          'p',
          'warn',
          'The screen flickers, but its frequency could not be pinned down reliably, so no shutter speed is recommended. Show a plain grey image on the screen, keep the phone still and measure again.',
        ),
        targetLink(),
        el('p', 'muted small', `Best guess, not reliable: ${shutterText(r.best)} s (${angleText(r.best, fps)}), ${r.frequency.toFixed(1)} Hz`),
      );
      notes(r);
      resultEl.hidden = false;
      return;
    }
    resultEl.append(
      el('div', 'speed', `${shutterText(r.best)} s`),
      el('div', 'angle', `${angleText(r.best, fps)} at ${fpsText(fps)} fps`),
      el('p', 'muted small', `Screen flicker: ${r.frequency.toFixed(2)} Hz`),
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
  notes(r);
  resultEl.hidden = false;
}

/** Notes on what the sweep couldn't measure (screen too bright or dark in parts). */
function notes(r: MeasureResult) {
  const add = (text: string) => resultEl.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: text }));
  if (r.limited?.slow) {
    add(`Shutter speeds slower than ${shutterText(r.swept[1])} s were not tested: the screen is too bright for this phone there. A darker grey image tests the full range.`);
  }
  if (r.limited?.fast) {
    add(`Shutter speeds faster than ${shutterText(r.swept[0])} s were not tested: the screen is too dark for this phone there. A lighter grey image tests the full range.`);
  }
  if (r.skipped) add(`${r.skipped} step${r.skipped > 1 ? 's were' : ' was'} too bright or too dark and skipped.`);
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
    camera: camera && { label: camera.track.label, backCameras: camera.cameras.map((c) => c.label) },
    timeSource: camera?.timeSource,
    texture: camera?.texture !== undefined ? +camera.texture.toFixed(4) : null,
    frameIntervals: r && frameIntervalStats(r),
    result: r && {
      kind: r.kind,
      frequency: 'frequency' in r ? round(r.frequency, 8) : null,
      best: 'best' in r ? round(r.best, 8) : null,
      clean: 'clean' in r ? r.clean.map((e) => round(e, 8)) : null,
      refined: 'refined' in r ? r.refined : null,
      confident: 'confident' in r ? r.confident : null,
      reference: 'reference' in r ? r.reference : null,
      explained: 'explained' in r && r.explained !== undefined ? +r.explained.toFixed(4) : null,
      message: 'message' in r ? r.message : null,
      range: r.range,
      swept: r.swept,
      limited: r.limited ?? null,
      calibration: r.calibration ? { ...r.calibration, k: round(r.calibration.k ?? undefined) } : null,
      skipped: r.skipped,
      fit: r.fit && { ...r.fit, anchors: r.fit.anchors.map((a) => round(a, 6)) },
      coherent: r.coherent,
    },
    grid: camera?.grid,
    // phase, exposure (s), iso, mean luma, clip fraction, valid, band energy, self covariance,
    // unaligned frames, mean alignment shift [dx, dy] (analysis px); full data adds frame
    // times and both channels' mean grids (row-major, grid.w x grid.h, log luma minus mean).
    steps: r?.steps.map((s) => [
      s.phase[0],
      round(s.exposure),
      s.iso ?? null,
      round(s.meanLuma, 4),
      round(s.clipFraction, 3),
      s.valid ? 1 : 0,
      round(s.energy, 4),
      round(s.profile.selfCov, 4),
      s.unaligned,
      s.shift ? s.shift.map((v) => +v.toFixed(2)) : null,
      ...(full ? [s.profile.times.map((t) => round(t, 9)), s.profile.mean.map((m) => [...m].map((v) => +v.toFixed(5)))] : []),
    ]),
  };
}

/** Frame interval statistics within steps (ms): shows how regular the frame times are. */
function frameIntervalStats(r: MeasureResult) {
  const d = r.steps.flatMap((s) => s.profile.times.slice(1).map((t, i) => (t - s.profile.times[i]) * 1000));
  if (!d.length) return null;
  const sorted = [...d].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const mad = [...d.map((v) => Math.abs(v - med))].sort((a, b) => a - b)[d.length >> 1];
  return { count: d.length, median: +med.toFixed(3), mad: +mad.toFixed(3), min: +sorted[0].toFixed(3), max: +sorted[sorted.length - 1].toFixed(3) };
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
