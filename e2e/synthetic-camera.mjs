// End-to-end check in headless Chromium with a synthetic camera: a canvas stream that
// renders rolling-shutter banding of a flickering screen for whatever exposure and ISO
// the app sets through applyConstraints. Runs the real app and reads its result.
//
//   npm run build && node e2e/synthetic-camera.mjs [flickerHz] [duty|sine] [projectFps]
//   PORTRAIT=1 renders rotated portrait frames (readout along x), as phones deliver upright.
//   TILT=1 lets the screen scan its rows across the readout (tilted bands, like OLEDs).
//   JITTER=1 adds hand shake (the content wanders a few pixels).
//   CONTENT=plain shows a plain light image instead of text.
//   BRIGHT=<factor> makes the screen that much brighter (3: too bright beyond ~1/45 s at min ISO).
//
// Needs a local Chromium: CHROMIUM_PATH, or the Playwright browser at /opt/pw-browsers.

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [flicker = '240', shape = '0.35', fps = '25'] = process.argv.slice(2);
const dist = new URL('../dist/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = normalize(join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  try {
    const body = await readFile(path.endsWith('/') ? join(path, 'index.html') : path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));

await page.addInitScript(
  ({ f, duty, portrait, tilt, jitter, plainContent, bright }) => {
    const W = portrait ? 360 : 640;
    const H = portrait ? 640 : 360;
    // Camera readout time across the frame's short side; the screen scans its own rows
    // across the long side (TILT=1), which tilts the bands as with OLED screens.
    const READOUT = 0.025;
    const SCAN = tilt ? 0.012 : 0;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const state = { exposureMode: 'continuous', exposureTime: 100, iso: 400 };
    // Screen content (larger than the frame, for hand shake): light page with text-like
    // rows of dark glyphs, a coloured header and a bar along one edge.
    const CW = W + 64;
    const CH = H + 64;
    const content = new Float32Array(CW * CH);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        let v = 0.8 - 0.1 * (y / CH);
        if (!plainContent && y < 50) v = 0.5;
        if (!plainContent && x > CW - 40) v = 0.25;
        content[y * CW + x] = v;
      }
    }
    for (let row = 70; plainContent ? false : row < CH - 20; row += 26) {
      for (let x = 20; x < CW - 60; ) {
        const w = 4 + Math.floor(rnd() * 10);
        if (rnd() < 0.8) for (let yy = row; yy < row + 12; yy++) for (let xx = x; xx < x + w; xx++) content[yy * CW + xx] = 0.15;
        x += w + 2 + Math.floor(rnd() * 4);
      }
    }
    const light = (t, e) => {
      if (duty === null) {
        const w = 2 * Math.PI * f;
        return 1 + (0.4 * (Math.cos(w * (t - e)) - Math.cos(w * t))) / (w * e);
      }
      const p = 1 / f;
      const cum = (x) => {
        const k = Math.floor(x / p);
        return k * duty * p + Math.min(x - k * p, duty * p);
      };
      return (cum(t) - cum(t - e)) / e / duty;
    };
    const img = ctx.createImageData(W, H);
    // Hand shake: smooth random walk of the content, a few pixels.
    let jx = 32;
    let jy = 32;
    let vx = 0;
    let vy = 0;
    // Frames carry exact timestamps on an ideal 30 fps grid when the browser can generate
    // tracks (as a phone camera's hardware timestamps would); else canvas capture timing.
    const Generator = window.MediaStreamTrackGenerator;
    const generator = Generator ? new Generator({ kind: 'video' }) : null;
    const writer = generator?.writable.getWriter();
    let frameIndex = 0;
    const draw = () => {
      const t0 = generator ? frameIndex / 30 : performance.now() / 1000;
      const e = state.exposureTime * 1e-4;
      const gain = (bright * e * state.iso) / (0.01 * 400);
      if (jitter) {
        vx = 0.9 * vx + 0.3 * (rnd() - 0.5);
        vy = 0.9 * vy + 0.3 * (rnd() - 0.5);
        jx = Math.min(56, Math.max(8, jx + vx));
        jy = Math.min(56, Math.max(8, jy + vy));
      }
      const ox = Math.round(jx);
      const oy = Math.round(jy);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // Readout position (camera) and screen row position (moves with the content).
          const r = portrait ? x / W : y / H;
          const srow = (portrait ? y + oy : x + ox) / (portrait ? CH : CW);
          const band = light(t0 + r * READOUT - srow * SCAN, e) * gain * 0.5;
          // Sensor noise (~2 levels) dithers the 8-bit frames, as on a real camera.
          const noise = 2 * (rnd() + rnd() + rnd() - 1.5);
          const v = 255 * Math.pow(Math.min(1, content[(y + oy) * CW + x + ox] * band), 1 / 2.2) + noise;
          const i = (y * W + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      if (writer) {
        const frame = new VideoFrame(canvas, { timestamp: Math.round(t0 * 1e6) });
        writer.write(frame).finally(() => frame.close());
      }
      frameIndex++;
    };
    setInterval(draw, 1000 / 30);
    draw();
    const stream = generator ? new MediaStream([generator]) : canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities.bind(track);
    const settings = track.getSettings.bind(track);
    track.getCapabilities = () => ({
      ...caps(),
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 1, max: 3330, step: 1 },
      iso: { min: 100, max: 3200, step: 1 },
    });
    track.getSettings = () => ({ ...settings(), ...state });
    track.applyConstraints = async (c) => {
      const adv = c?.advanced?.[0] ?? {};
      if (adv.exposureTime !== undefined && state.exposureMode !== 'manual' && adv.exposureMode !== 'manual') {
        throw new DOMException('exposureTime needs manual mode', 'OverconstrainedError');
      }
      if (adv.exposureMode) state.exposureMode = adv.exposureMode;
      if (adv.exposureTime !== undefined) state.exposureTime = adv.exposureTime;
      if (adv.iso !== undefined) state.iso = adv.iso;
    };
    navigator.mediaDevices.getUserMedia = async () => stream;
  },
  {
    f: Number(flicker),
    duty: shape === 'sine' ? null : Number(shape),
    portrait: !!process.env.PORTRAIT,
    tilt: !!process.env.TILT,
    jitter: !!process.env.JITTER,
    plainContent: process.env.CONTENT === 'plain',
    bright: Number(process.env.BRIGHT ?? 1),
  },
);

await page.goto(`http://localhost:${port}/index.html`);
await page.selectOption('#fps', fps);
await page.waitForSelector('#measure:not([disabled])', { timeout: 15000 });
const t0 = Date.now();
await page.click('#measure');
await page.waitForFunction(() => !document.querySelector('#result').hidden || !document.querySelector('#error').hidden, null, {
  timeout: 240000,
});
const result = (await page.textContent('#result')) || (await page.textContent('#error'));
await page.click('.diag summary');
await page.click('#copyDiag');
const report = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
console.log(`flicker ${flicker} Hz (${shape}), ${fps} fps, ${((Date.now() - t0) / 1000).toFixed(0)} s:`);
console.log(result.replace(/\s+/g, ' ').trim());
const { kind, frequency, reference, explained } = report.result ?? {};
console.log(`report: ${kind} f=${frequency} ref=${reference} explained=${explained} timeSource=${report.timeSource} frameIntervals=${JSON.stringify(report.frameIntervals)}`);
const fit = report.result?.fit;
if (fit) console.log(`fit: f=${fit.frequency?.toFixed(2)} amp=${fit.amplitude?.toFixed(5)} floor=${fit.floor?.toFixed(5)} conf=${fit.confidence?.toFixed(2)} candidates=${fit.candidates?.map((c) => c.toFixed(1)).join(',')}`);
console.log(`coherent: ${JSON.stringify(report.result?.coherent)}`);
console.log(`texture: ${report.texture}`);
console.log(`calibration: ${JSON.stringify(report.result?.calibration)} swept: ${JSON.stringify(report.result?.swept)} limited: ${JSON.stringify(report.result?.limited)} camera: ${JSON.stringify(report.camera)}`);
if (process.env.DUMP) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadDiag')]);
  await download.saveAs(process.env.DUMP);
}
await page.screenshot({ path: process.env.SCREENSHOT ?? 'e2e-result.png', fullPage: true });
await browser.close();
server.close();
