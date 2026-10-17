// End-to-end check in headless Chromium with a synthetic camera: a canvas stream that
// renders rolling-shutter banding of a flickering screen for whatever exposure and ISO
// the app sets through applyConstraints. Runs the real app and reads its result.
//
//   npm run build && node e2e/synthetic-camera.mjs [flickerHz] [duty|sine] [projectFps]
//   PORTRAIT=1 renders rotated portrait frames (readout along x), as phones deliver upright.
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
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

await page.addInitScript(
  ({ f, duty, portrait }) => {
    const W = portrait ? 360 : 640;
    const H = portrait ? 640 : 360;
    const READOUT = 0.025;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const state = { exposureMode: 'continuous', exposureTime: 100, iso: 400 };
    // Screen content: a desktop-like image with a gradient, a window and a taskbar.
    const content = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 0.55 + 0.25 * (x / W) - 0.1 * (y / H);
        if (x > 120 && x < 420 && y > 60 && y < 260) v = 0.85;
        if (y > H - 30) v = 0.2;
        content[y * W + x] = v;
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
    const draw = () => {
      const t0 = performance.now() / 1000;
      const e = state.exposureTime * 1e-4;
      const gain = (e * state.iso) / (0.01 * 400);
      // The sensor reads out along the frame's short side: rows, or columns when rotated.
      const lines = portrait ? W : H;
      const bands = Array.from({ length: lines }, (_, i) => light(t0 + (i / lines) * READOUT, e) * gain * 0.5);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const band = portrait ? bands[x] : bands[y];
          const v = 255 * Math.pow(Math.min(1, content[y * W + x] * band), 1 / 2.2);
          const i = (y * W + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    setInterval(draw, 1000 / 30);
    draw();
    const stream = canvas.captureStream(30);
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
  { f: Number(flicker), duty: shape === 'sine' ? null : Number(shape), portrait: !!process.env.PORTRAIT },
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
console.log(`flicker ${flicker} Hz (${shape}), ${fps} fps, ${((Date.now() - t0) / 1000).toFixed(0)} s:`);
console.log(result.replace(/\s+/g, ' ').trim());
await page.screenshot({ path: process.env.SCREENSHOT ?? 'e2e-result.png', fullPage: true });
await browser.close();
server.close();
