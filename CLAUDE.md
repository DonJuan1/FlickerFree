# FlickerFree -- Project Knowledge

Mobile web app (Chrome on Android) that measures a flickering screen with the phone camera and tells the user which **shutter speed to set on their cinema camera** (ARRI / Sony / RED) so the screen doesn't flicker on film. Physics: banding vanishes when exposure = n / f_flicker, for any camera, so a value clean on the phone is clean on the cinema camera.

## Agreed scope
- **One screen, no manual settings**: live view with an outline of the analysed area, project-fps picker (23.976/24/25/29.97/30/48/50/59.94/60, default 25, remembered), Measure button, progress + Stop. Instructions recommend a plain white image on the screen.
- **Result**: clean shutter value closest to **180 degrees** at the project fps, as shutter speed (`1/48.1 s`) and angle (`187.2 deg at 25 fps`), other clean values below, flicker frequency in small text. "No flicker detected" if none. If the frequency isn't reliable: "Flicker found, frequency unclear" with advice and the guess in small print only (no recommendation).
- **Result range** 360 degrees (1/fps) to 1/250; the **sweep** goes to at least 1/20.
- Chrome on Android with manual `exposureTime` (+ `iso`); otherwise a "not supported" message. Test device: OnePlus 7T.
- `probe.html` stays as a diagnostics page (linked under Diagnostics).

## What real screens look like (from user recordings)
- OnePlus 7T OLED (90 Hz): a **short dark dip once per refresh** (~15% darker at 1/2000 after gamma, width scales with exposure), not PWM.
- OLEDs scan their rows; with the phone held portrait the camera reads out across them, so **bands are tilted** (~38 deg here) and their pattern repeats over ~1000 px, more than the analysed area.
- Bands drifted ~2.8% of a period per frame (screen ~90.8 or 89.2 Hz vs camera 30.000 fps). Clock mismatches of tens of ppm make **near-locked, slowly drifting bands** common for 60/90/120/240 Hz screens at 30 fps.

## Camera pipeline (`src/lib/camera.ts`)
- Frame downscaled to 320 px long side; **aligned to a reference frame** (translation, phase correlation in `register.ts`) against hand shake; centred 70% region averaged into 3 x 3 px cells; even/odd cell columns = channels A/B (cross products remove sensor noise).
- **Edge weights** from the reference (1 / (1 + v/median v)^2, v = in-cell variance): text edges leave alignment residue, bands are smooth. ~8x less residue on real recordings.
- **Plain screens are not aligned** (texture level < 0.02): alignment would lock onto the bands and cancel their real movement.
- Frame times: `captureTime`, else `mediaTime`, else callback time (reported as `timeSource`). The coherent analysis needs sub-ms accuracy.
- `exposureTime` in 100 us units; manual mode applied in its own call first; `applyConstraints` resends base constraints + the accumulated advanced set; capabilities read after the first frame + 700 ms.

## Measurement (`src/lib/measure.ts`)
1. ISO calibration at the geometric-mean exposure (luma ~115), then exposure x ISO constant.
2. Alignment reference at that mid exposure.
3. Sweep 1/250 .. max(1/20, 1/fps), ratio 1.025 (~104 steps), **two interleaved passes** (even steps up, odd down: breaks the exposure/time correlation that made slow drift look like a frequency offset). Per step: drop 5-7 frames (**uneven** to avoid aliases at 1/step-duration), keep 5. Steps with luma < 12 or > 2% clipped are skipped.
4. Null-based fit (`analysis.ts`): `SweepModel` distances between steps (content cancels), `fitFlicker` grid search scoring log null depth, sub-harmonic check, polish; returns candidates. Flicker present if band amplitude >= 2.5x the within-step noise floor and >= 0.0004.
5. **Coherent model** (`coherent.ts`): mean_step = content + sum_h Re{z_h(E) phi_h(step) P_h}, with z_h the exposure-window average and phi_h the mean of e^{i 2 pi h f t} over the step's frames (capture times). Covers standing, drifting and rolling bands; band phase accumulates over the sweep, pinning f to ~0.1 / duration. Broad scan 40-330 Hz with the fundamental (incremental phase rotation, low-rank Gram), plus the null fit's candidates up to 3000 Hz (local scans), polished with 6 harmonics; best explained wins, integer-multiple ties go to the multiple, unless the null fit chose the lower one on purpose. **Trusted when its scan peak's significance (robust z) >= 15** and explained >= 0.3; then final (no refinement).
6. Otherwise refinement around the clean value nearest 180 deg (9 exposures, up and down, energies x exposure^2, symmetric V/U dip fit) against two content references (average of steps beyond the first null; centroid of the null steps), keeping the one with the lowest dip floor. Moves capped at 3%. Confident only if refined with null contrast >= 0.9; else reported as unclear.

### Known limits
- Weak dips + busy content (text) + hand shake: often "unclear". A plain white screen fixes it (exact in tests).
- Frequencies f and f +- 30 Hz look alike to the coherent model at 30 fps (only the exposure dependence separates them); noisy sweeps can confuse them.
- Fast-rolling bands (e.g. 360 Hz at 30.5 fps) give the coherent model little to work with; the null fit handles them.
- Real-device behaviour (timestamps, exposure latency, ISO support, noise) is unverified until the user's diagnostics come in.

## Testing
- `npm test`: unit + simulated measurements (`test/sim.ts`: 2D grid, tilt via `scan`, PWM/sine/dip, drift via `cameraFps`, `timeJitter`, content types).
- `npm run build && npm run e2e -- <Hz> <duty|sine> <fps>`: headless Chromium, real app with a synthetic camera (MediaStreamTrackGenerator with exact timestamps, sensor noise, gamma). Env: `PORTRAIT=1`, `TILT=1`, `JITTER=1` (hand shake), `CONTENT=plain`, `DUMP=<file>` (full data export).
- Diagnostics in the app: "Copy report" (caps, timeSource, frame intervals, texture, result incl. coherent candidates, per-step data) and "Download full data" (adds frame times and both channels' mean grids).
- Gotchas: don't `pkill -f vitest` from a shell whose command line contains the pattern; vitest prints console output only at the end (append to files for long runs); debug tests that import `node:fs` break `tsc` if left in `test/`.

## Stack / repo
TypeScript + Vite, no framework; `base: './'`; multi-page (`index.html`, `probe.html`). GitHub Pages deploy on push to `main` (tests run first). Work directly on `main`.
