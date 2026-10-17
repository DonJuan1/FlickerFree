import { analyzeFrame, detrendRelative, type FrameStats } from './frameStats';

// Camera probe: reports which exposure controls Chrome exposes on this device and
// measures how the image actually responds to them.

type Range = { min: number; max: number; step?: number };
type Caps = Record<string, unknown>;
type ConstraintSet = Record<string, unknown>;

const PROBE_VERSION = 1;
/** Max length of the longer side of the frame copy used for analysis. */
const ANALYSIS_SIZE = 480;
const RANGE_KEYS = [
  'exposureTime',
  'iso',
  'exposureCompensation',
  'frameRate',
  'focusDistance',
  'colorTemperature',
  'zoom',
  'brightness',
  'contrast',
  'saturation',
  'sharpness',
];
const ENUM_KEYS = ['exposureMode', 'focusMode', 'whiteBalanceMode'];
/** Settings that only take effect while their mode is 'manual'. */
const MODE_OF: Record<string, string> = {
  exposureTime: 'exposureMode',
  iso: 'exposureMode',
  focusDistance: 'focusMode',
  colorTemperature: 'whiteBalanceMode',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const videoEl = $<HTMLVideoElement>('video');
const plotEl = $<HTMLCanvasElement>('plot');
const cameraSel = $<HTMLSelectElement>('camera');
const resolutionSel = $<HTMLSelectElement>('resolution');
const startBtn = $<HTMLButtonElement>('start');
const refreshCapsBtn = $<HTMLButtonElement>('refreshCaps');
const runTestBtn = $<HTMLButtonElement>('runTest');
const testStatusEl = $('testStatus');
const testTable = $<HTMLTableElement>('testTable');
const controlsEl = $('controls');
const liveEl = $('live');
const reportEl = $('report');
const logEl = $('log');

const analysisCanvas = document.createElement('canvas');
const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true })!;
const plotCtx = plotEl.getContext('2d')!;

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
/** Width/height/frameRate/device constraints, resent with every applyConstraints call. */
let baseConstraints: MediaTrackConstraints = {};
/** Accumulated image-capture settings (exposure etc.), resent as one advanced set. */
let imageSet: ConstraintSet = {};
let caps: Caps = {};
let latest: FrameStats | null = null;
let frameCount = 0;
let loopToken = 0;
let testRows: TestRow[] = [];
const logLines: string[] = [];
const frameTimes: number[] = [];
let timeSource = '';
let skippedCallbacks = 0;
let lastPresented = -1;

type FrameWaiter = (s: FrameStats, t: number) => void;
let frameWaiters: FrameWaiter[] = [];

interface TestRow {
  requested: number;
  reported: unknown;
  iso: unknown;
  meanLuma: number;
  settleFrames: number;
  settleMs: number;
  fps: number;
  rowBand: number;
  colBand: number;
}

// ---------- helpers ----------

const t0 = performance.now();

function log(msg: string, bad = false) {
  const line = `${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}s ${bad ? '!! ' : ''}${msg}`;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function isRange(v: unknown): v is Range {
  return typeof v === 'object' && v !== null && 'min' in v && 'max' in v;
}

/** exposureTime is specified in units of 100 microseconds. */
function exposureLabel(units: number): string {
  const ms = units / 10;
  return `${units} (${ms.toFixed(ms < 1 ? 2 : 1)} ms = 1/${(1000 / ms).toFixed(ms > 10 ? 1 : 0)} s)`;
}

function formatValue(key: string, v: number): string {
  return key === 'exposureTime' ? exposureLabel(v) : String(+v.toFixed(3));
}

function snap(v: number, r: Range): number {
  const step = r.step && r.step > 0 ? r.step : 0;
  const s = step ? r.min + Math.round((v - r.min) / step) * step : v;
  return Math.min(r.max, Math.max(r.min, +s.toFixed(6)));
}

function measuredFps(): number {
  if (frameTimes.length < 2) return 0;
  const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
  return span > 0 ? ((frameTimes.length - 1) * 1000) / span : 0;
}

function settings(): ConstraintSet {
  return track ? (track.getSettings() as unknown as ConstraintSet) : {};
}

// ---------- environment ----------

function describeEnv() {
  const sc = navigator.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined;
  const wanted = ['exposureMode', 'exposureTime', 'iso', 'frameRate'];
  const support = sc ? wanted.map((k) => `${k}: ${sc[k] ? 'yes' : 'no'}`).join(', ') : 'mediaDevices unavailable';
  $('env').textContent = `Secure context: ${window.isSecureContext ? 'yes' : 'NO (camera blocked)'}. Browser says it supports ${support}.`;
}

async function uaDetails(): Promise<unknown> {
  const uaData = (navigator as unknown as { userAgentData?: { getHighEntropyValues(h: string[]): Promise<unknown> } })
    .userAgentData;
  if (!uaData) return null;
  try {
    return await uaData.getHighEntropyValues(['model', 'platform', 'platformVersion', 'fullVersionList']);
  } catch (e) {
    return errText(e);
  }
}

async function refreshDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = track?.getSettings().deviceId;
  cameraSel.replaceChildren(new Option('Back camera (default)', ''));
  devices.forEach((d, i) => cameraSel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (current) cameraSel.value = current;
  return devices.map((d) => d.label);
}

// ---------- camera ----------

async function startCamera() {
  stopCamera();
  const [w, h] = resolutionSel.value.split('x').map(Number);
  baseConstraints = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (cameraSel.value) baseConstraints.deviceId = { exact: cameraSel.value };
  else baseConstraints.facingMode = { ideal: 'environment' };
  imageSet = {};
  log(`getUserMedia ${JSON.stringify(baseConstraints)}`);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: baseConstraints, audio: false });
  } catch (e) {
    log(`getUserMedia failed: ${errText(e)}`, true);
    return;
  }
  track = stream.getVideoTracks()[0];
  log(`track: ${track.label}`);
  track.addEventListener('ended', () => log('track ended', true));
  videoEl.srcObject = stream;
  await videoEl.play().catch((e) => log(`video.play failed: ${errText(e)}`, true));
  await refreshDevices();
  startFrameLoop();
  // Chrome on Android can report image-capture capabilities only after the device is running.
  await sleep(700);
  readCaps();
  refreshCapsBtn.disabled = false;
}

function stopCamera() {
  loopToken++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
  frameTimes.length = 0;
  latest = null;
}

function readCaps() {
  if (!track) return;
  caps = track.getCapabilities() as unknown as Caps;
  log(`capabilities: ${JSON.stringify(caps)}`);
  log(`settings: ${JSON.stringify(settings())}`);
  buildControls();
  const r = caps.exposureTime;
  const manual = Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual');
  runTestBtn.disabled = !(isRange(r) && manual);
  testStatusEl.textContent = runTestBtn.disabled ? 'Not available: no manual exposureTime on this camera.' : '';
  testStatusEl.classList.toggle('bad', runTestBtn.disabled);
  void updateReport();
}

async function apply(change: ConstraintSet): Promise<boolean> {
  if (!track) return false;
  const tStart = performance.now();
  let constraints: MediaTrackConstraints;
  if ('frameRate' in change) {
    baseConstraints = { ...baseConstraints, frameRate: { ideal: change.frameRate as number } };
    constraints = { ...baseConstraints, advanced: [imageSet as MediaTrackConstraintSet] };
  } else {
    const next = { ...imageSet, ...change };
    // Leaving manual mode: drop the values that only apply in manual mode.
    for (const [key, mode] of Object.entries(MODE_OF)) {
      if (mode in change && change[mode] !== 'manual') delete next[key];
    }
    constraints = { ...baseConstraints, advanced: [next as MediaTrackConstraintSet] };
    imageSet = next;
  }
  try {
    await track.applyConstraints(constraints);
    const s = settings();
    const readback = Object.keys(change)
      .map((k) => `${k}=${JSON.stringify(s[k])}`)
      .join(' ');
    log(`apply ${JSON.stringify(change)} ok (${(performance.now() - tStart).toFixed(0)} ms), now ${readback}`);
    return true;
  } catch (e) {
    log(`apply ${JSON.stringify(change)} FAILED: ${errText(e)}`, true);
    return false;
  }
}

/** Switches the mode a setting depends on to manual first (two separate calls, as Chrome needs). */
async function applyWithMode(key: string, value: number): Promise<boolean> {
  const mode = MODE_OF[key];
  if (mode && settings()[mode] !== 'manual' && Array.isArray(caps[mode]) && (caps[mode] as string[]).includes('manual')) {
    if (!(await apply({ [mode]: 'manual' }))) return false;
    const sel = controlsEl.querySelector<HTMLSelectElement>(`select[data-key="${mode}"]`);
    if (sel) sel.value = 'manual';
  }
  return apply({ [key]: value });
}

// ---------- controls ----------

function buildControls() {
  controlsEl.replaceChildren();
  const s = settings();

  for (const key of ENUM_KEYS) {
    const options = caps[key];
    if (!Array.isArray(options) || options.length === 0) continue;
    const sel = document.createElement('select');
    sel.dataset.key = key;
    for (const o of options) sel.add(new Option(String(o), String(o)));
    if (typeof s[key] === 'string') sel.value = s[key] as string;
    sel.addEventListener('change', () => void apply({ [key]: sel.value }));
    controlsEl.append(control(key, sel, null));
  }

  for (const key of RANGE_KEYS) {
    const r = caps[key];
    if (!isRange(r) || !(r.max > r.min)) continue;
    // Exposure spans several decades, so its slider is logarithmic.
    const logScale = key === 'exposureTime' && r.min > 0;
    const input = document.createElement('input');
    input.type = 'range';
    const valueEl = document.createElement('span');
    const toValue = (pos: number) =>
      snap(logScale ? r.min * Math.pow(r.max / r.min, pos / 1000) : r.min + ((r.max - r.min) * pos) / 1000, r);
    const toPos = (v: number) =>
      logScale ? (1000 * Math.log(v / r.min)) / Math.log(r.max / r.min) : (1000 * (v - r.min)) / (r.max - r.min);
    input.min = '0';
    input.max = '1000';
    input.step = '1';
    const current = typeof s[key] === 'number' ? (s[key] as number) : r.min;
    input.value = String(Math.round(toPos(current)));
    valueEl.textContent = formatValue(key, current);
    input.addEventListener('input', () => (valueEl.textContent = formatValue(key, toValue(+input.value))));
    input.addEventListener('change', () => void applyWithMode(key, toValue(+input.value)));
    const rangeText = `${formatValue(key, r.min)} .. ${formatValue(key, r.max)}, step ${r.step ?? '-'}`;
    controlsEl.append(control(key, input, valueEl, rangeText));
  }

  if (!controlsEl.childElementCount) {
    controlsEl.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No adjustable camera controls reported.' }));
  }
}

function control(key: string, input: HTMLElement, valueEl: HTMLElement | null, hint?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'control';
  const label = document.createElement('label');
  label.append(Object.assign(document.createElement('span'), { textContent: key }));
  if (valueEl) label.append(valueEl);
  wrap.append(label, input);
  if (hint) wrap.append(Object.assign(document.createElement('div'), { className: 'muted small', textContent: hint }));
  return wrap;
}

// ---------- frame loop ----------

function startFrameLoop() {
  const token = ++loopToken;
  lastPresented = -1;
  skippedCallbacks = 0;
  const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
    if (token !== loopToken) return;
    const t = meta.captureTime ?? now;
    timeSource = meta.captureTime !== undefined ? 'captureTime' : 'callback time';
    if (lastPresented >= 0 && meta.presentedFrames > lastPresented + 1) {
      skippedCallbacks += meta.presentedFrames - lastPresented - 1;
    }
    lastPresented = meta.presentedFrames;
    frameTimes.push(t);
    if (frameTimes.length > 61) frameTimes.shift();
    processFrame(t);
    videoEl.requestVideoFrameCallback(onFrame);
  };
  videoEl.requestVideoFrameCallback(onFrame);
}

function processFrame(t: number) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(1, ANALYSIS_SIZE / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  if (analysisCanvas.width !== w || analysisCanvas.height !== h) {
    analysisCanvas.width = w;
    analysisCanvas.height = h;
  }
  analysisCtx.drawImage(videoEl, 0, 0, w, h);
  const stats = analyzeFrame(analysisCtx.getImageData(0, 0, w, h).data, w, h);
  latest = stats;
  frameCount++;
  const waiters = frameWaiters;
  frameWaiters = [];
  waiters.forEach((fn) => fn(stats, t));
  if (frameCount % 3 === 0) drawPlot(stats);
  if (frameCount % 8 === 0) updateLive();
}

/** Collects the next n analysed frames, or fewer if timeoutMs passes first. */
function nextFrames(n: number, timeoutMs: number): Promise<{ s: FrameStats; t: number }[]> {
  return new Promise((resolve) => {
    const out: { s: FrameStats; t: number }[] = [];
    const timer = setTimeout(() => resolve(out), timeoutMs);
    const take: FrameWaiter = (s, t) => {
      out.push({ s, t });
      if (out.length >= n) {
        clearTimeout(timer);
        resolve(out);
      } else frameWaiters.push(take);
    };
    frameWaiters.push(take);
  });
}

function drawPlot(stats: FrameStats) {
  const { width: W, height: H } = plotEl;
  plotCtx.clearRect(0, 0, W, H);
  plotCtx.strokeStyle = '#333';
  plotCtx.beginPath();
  plotCtx.moveTo(0, H / 2);
  plotCtx.lineTo(W, H / 2);
  plotCtx.stroke();
  const series: [Float32Array, string][] = [
    [detrendRelative(stats.rowProfile), '#ffb020'],
    [detrendRelative(stats.colProfile), '#4aa8ff'],
  ];
  // Fixed scale: +-25% of mean brightness fills the plot height.
  const gain = H / 2 / 0.25;
  for (const [d, color] of series) {
    if (d.length < 2) continue;
    plotCtx.strokeStyle = color;
    plotCtx.lineWidth = 2;
    plotCtx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = (i / (d.length - 1)) * W;
      const y = H / 2 - Math.max(-1, Math.min(1, (d[i] * gain) / (H / 2))) * (H / 2);
      if (i === 0) plotCtx.moveTo(x, y);
      else plotCtx.lineTo(x, y);
    }
    plotCtx.stroke();
  }
}

function updateLive() {
  if (!track || !latest) return;
  const s = settings();
  const rows: [string, string][] = [
    ['Track', track.label],
    ['Frame size', `${videoEl.videoWidth} x ${videoEl.videoHeight}`],
    ['Measured fps', `${measuredFps().toFixed(1)} (${timeSource}), skipped callbacks ${skippedCallbacks}`],
    ['Mean luma', latest.meanLuma.toFixed(1)],
    ['Band RMS', `vertical axis ${(latest.rowBand * 100).toFixed(2)}%, horizontal axis ${(latest.colBand * 100).toFixed(2)}%`],
    ['exposureMode', String(s.exposureMode ?? '-')],
    ['exposureTime', typeof s.exposureTime === 'number' ? exposureLabel(s.exposureTime) : '-'],
    ['iso', String(s.iso ?? '-')],
    ['frameRate setting', String(s.frameRate ?? '-')],
  ];
  liveEl.replaceChildren(
    ...rows.flatMap(([k, v]) => [
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: v }),
    ]),
  );
}

// ---------- exposure response test ----------

async function runTest() {
  const r = caps.exposureTime;
  if (!track || !isRange(r)) return;
  runTestBtn.disabled = true;
  startBtn.disabled = true;
  testRows = [];
  renderTable();
  try {
    const fps = measuredFps() || 30;
    // Up to twice the frame interval, to see whether long exposures lower the frame rate.
    const upper = Math.min(r.max, (2 * 10000) / fps);
    const lower = Math.max(r.min, r.step && r.step > 0 ? r.step : r.min, 0.1);
    const n = 14;
    const values = [...new Set(Array.from({ length: n }, (_, i) => snap(lower * Math.pow(upper / lower, i / (n - 1)), r)))];
    log(`test: ${values.length} exposure values ${values.join(', ')}`);
    if (settings().exposureMode !== 'manual' && !(await apply({ exposureMode: 'manual' }))) {
      testStatusEl.textContent = 'Could not switch to manual exposure.';
      return;
    }

    for (const [i, v] of values.entries()) {
      testStatusEl.textContent = `Step ${i + 1}/${values.length}: ${exposureLabel(v)}`;
      const tApply = performance.now();
      const pending = nextFrames(36, 3000);
      await apply({ exposureTime: v });
      const frames = await pending;
      if (frames.length < 12) {
        log(`test: only ${frames.length} frames at ${v}`, true);
        continue;
      }
      const tail = frames.slice(-8);
      const final = avg(tail.map((f) => f.s.meanLuma));
      // First frame after which every frame stays within 3% (or 1.5 luma) of the final level.
      let settle = frames.length - 1;
      for (let k = frames.length - 1; k >= 0; k--) {
        if (Math.abs(frames[k].s.meanLuma - final) > Math.max(1.5, 0.03 * final)) break;
        settle = k;
      }
      const span = tail[tail.length - 1].t - tail[0].t;
      const s = settings();
      testRows.push({
        requested: v,
        reported: s.exposureTime,
        iso: s.iso,
        meanLuma: final,
        settleFrames: settle,
        // Frame timestamps share performance.now()'s clock.
        settleMs: Math.max(0, frames[settle].t - tApply),
        fps: span > 0 ? ((tail.length - 1) * 1000) / span : 0,
        rowBand: avg(tail.map((f) => f.s.rowBand)),
        colBand: avg(tail.map((f) => f.s.colBand)),
      });
      renderTable();
    }
    testStatusEl.textContent = 'Done. Exposure is left in manual mode; switch exposureMode back to continuous above if needed.';
  } catch (e) {
    log(`test failed: ${errText(e)}`, true);
    testStatusEl.textContent = 'Test failed, see log.';
  } finally {
    runTestBtn.disabled = false;
    startBtn.disabled = false;
    void updateReport();
  }
}

function avg(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / (a.length || 1);
}

function renderTable() {
  const head = ['req', 'ms', '1/x s', 'reported', 'iso', 'luma', 'luma/ms', 'settle fr', 'settle ms', 'fps', 'band V %', 'band H %'];
  const rows = testRows.map((r) => {
    const ms = r.requested / 10;
    return [
      r.requested,
      ms.toFixed(2),
      (1000 / ms).toFixed(1),
      String(r.reported ?? '-'),
      String(r.iso ?? '-'),
      r.meanLuma.toFixed(1),
      (r.meanLuma / ms).toFixed(1),
      r.settleFrames,
      r.settleMs.toFixed(0),
      r.fps.toFixed(1),
      (r.rowBand * 100).toFixed(2),
      (r.colBand * 100).toFixed(2),
    ].map(String);
  });
  testTable.replaceChildren();
  if (!rows.length) return;
  const thead = testTable.createTHead().insertRow();
  head.forEach((h) => thead.append(Object.assign(document.createElement('th'), { textContent: h })));
  const body = testTable.createTBody();
  rows.forEach((cells) => {
    const tr = body.insertRow();
    cells.forEach((c) => (tr.insertCell().textContent = c));
  });
}

// ---------- report ----------

async function buildReport() {
  const devices = await navigator.mediaDevices
    .enumerateDevices()
    .then((ds) => ds.filter((d) => d.kind === 'videoinput').map((d) => d.label))
    .catch((e) => errText(e));
  return {
    probeVersion: PROBE_VERSION,
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    uaData: await uaDetails(),
    secureContext: window.isSecureContext,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, orientation: screen.orientation?.type },
    supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.(),
    videoInputs: devices,
    track: track?.label ?? null,
    baseConstraints,
    imageSet,
    capabilities: caps,
    settings: settings(),
    constraints: track?.getConstraints() ?? null,
    video: { w: videoEl.videoWidth, h: videoEl.videoHeight },
    live: latest && {
      fps: +measuredFps().toFixed(2),
      timeSource,
      skippedCallbacks,
      meanLuma: +latest.meanLuma.toFixed(2),
      rowBand: +latest.rowBand.toFixed(5),
      colBand: +latest.colBand.toFixed(5),
    },
    exposureTest: testRows,
    log: logLines,
  };
}

async function updateReport() {
  reportEl.textContent = JSON.stringify(await buildReport(), null, 1);
}

async function copyReport() {
  await updateReport();
  const text = reportEl.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    log('report copied to clipboard');
  } catch (e) {
    log(`clipboard failed (${errText(e)}); select the report text manually`, true);
    getSelection()?.selectAllChildren(reportEl);
  }
}

async function downloadReport() {
  await updateReport();
  const blob = new Blob([reportEl.textContent ?? ''], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `flickerfree-probe-${Date.now()}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- wiring ----------

describeEnv();
cameraSel.add(new Option('Back camera (default)', ''));
startBtn.addEventListener('click', () => void startCamera());
refreshCapsBtn.addEventListener('click', readCaps);
runTestBtn.addEventListener('click', () => void runTest());
$('copy').addEventListener('click', () => void copyReport());
$('download').addEventListener('click', () => void downloadReport());
window.addEventListener('error', (e) => log(`error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) => log(`unhandled: ${errText(e.reason)}`, true));
void updateReport();
