# FlickerFree -- Project Knowledge

Mobile web app (Chrome on Android) that measures a flickering screen with the phone camera and tells the user which **shutter speed to set on their cinema camera** (ARRI / Sony / RED) so the screen doesn't flicker on film. Physics: banding vanishes when exposure = n / f_flicker, for any camera, so a value clean on the phone is clean on the cinema camera.

## Agreed scope
- **One screen, no manual settings**: live view with an outline of the analysed area, project-fps picker (23.976/24/25/29.97/30/48/50/59.94/60, default 25, remembered), Measure button, progress + Stop. A camera picker appears only when there is more than one back camera (main camera by default, choice remembered). Instructions recommend a plain grey image on the screen (`target.html`) at the brightness setting used on set.
- **Result**: clean shutter value closest to **180 degrees** at the project fps, as shutter speed (`1/48.1 s`) and angle (`187.2 deg at 25 fps`), other clean values below, flicker frequency in small text. "No flicker detected" if none. If the frequency isn't reliable: "Flicker found, frequency unclear" with advice and the guess in small print only (no recommendation).
- **Result range** 360 degrees (1/fps) to 1/250; the **sweep** goes to at least 1/20.
- Chrome on Android with manual `exposureTime` (+ `iso`); otherwise a "not supported" message. Test device: OnePlus 7T.
- `probe.html` stays as a diagnostics page (linked under Diagnostics). `target.html` is the grey test image to open on the measured screen (levels 5-100%, default 20%, tap left/right or arrow keys).

## What real screens look like (from user recordings)
- OnePlus 7T OLED (90 Hz): a **short dark dip once per refresh** (~15% darker at 1/2000 after gamma, width scales with exposure), not PWM.
- OLEDs scan their rows; with the phone held portrait the camera reads out across them, so **bands are tilted** (~38 deg here) and their pattern repeats over ~1000 px, more than the analysed area.
- Bands drifted ~2.8% of a period per frame (screen ~90.8 or 89.2 Hz vs camera 30.000 fps). Clock mismatches of tens of ppm make **near-locked, slowly drifting bands** common for 60/90/120/240 Hz screens at 30 fps.

## Brightness (why a grey image)
- Phone cameras have a fixed aperture and a minimum ISO, so a bright screen clips at long exposures: a white ~400 nit screen needs ~1/1000 s at ISO 100. A **darker image** fixes it; a lower **brightness setting** may not be equivalent, since it can switch the screen to PWM dimming (different flicker).
- Image content doesn't change the flicker frequency, which is all the result depends on.

## Camera pipeline (`src/lib/camera.ts`)
- **Main back camera** (`devices.ts`): Chrome may open an extra lens (ultra-wide) for `facingMode: environment`. Labels are `camera2 <id>, facing back|front`; Android id 0 is the main back camera, so the lowest back id wins (else the listed order; `InputDeviceInfo.getCapabilities().facingMode` beats the label). Ids/labels are listed only after access is granted: a first visit opens the browser's choice, then reopens with `deviceId: exact`.
- Frame downscaled to 320 px long side; **aligned to a reference frame** (translation, phase correlation in `register.ts`) against hand shake; centred 70% region averaged into 3 x 3 px cells; even/odd cell columns = channels A/B (cross products remove sensor noise).
- **Edge weights** from the reference (1 / (1 + v/median v)^2, v = in-cell variance): text edges leave alignment residue, bands are smooth. ~8x less residue on real recordings.
- **Plain screens are not aligned** (texture level < 0.02): alignment would lock onto the bands and cancel their real movement.
- Frame times: `captureTime`, else `mediaTime`, else callback time (reported as `timeSource`). The coherent analysis needs sub-ms accuracy.
- `exposureTime` in 100 us units; manual mode applied in its own call first; `applyConstraints` resends base constraints + the accumulated advanced set; capabilities read after the first frame + 700 ms.

## Measurement (`src/lib/measure.ts`)
1. **Brightness calibration** (target luma 80, headroom for where ISO runs out): ISO first, then exposure (within the sweep range) once ISO is at a limit; k = exposure x ISO (x (80/L)^2.2). Each change is checked against the measured luma: if ISO changes don't move it, exposure alone is used (`isoControl: false`); if exposure changes don't either (camera still adjusting itself), the full sweep runs and each step is judged on its own luma (`exposureControl: false`).
2. **Feasible range**: the sweep keeps exposures whose brightness, with ISO clamped, stays within 1/16..8x the target; ends left out are reported (`limited.fast` = too dark, `limited.slow` = too bright) and shown as a note. Error `too-bright`/`too-dark` (with a link to `target.html`) if nothing usable remains, the top is below 1/100 or the span below 3x.
3. Alignment reference at the mid exposure of the feasible range.
4. Sweep 1/250 .. max(1/20, 1/fps), ratio 1.025 (~104 steps), **two interleaved passes** (even steps up, odd down: breaks the exposure/time correlation that made slow drift look like a frequency offset). Per step: drop 5-7 frames (**uneven** to avoid aliases at 1/step-duration), keep 5; ISO = k / exposure, clamped. Steps with luma < 10 or > 2% clipped pixels are skipped.
5. Null-based fit (`analysis.ts`): `SweepModel` distances between steps (content cancels), `fitFlicker` grid search scoring log null depth, sub-harmonic check, polish; returns candidates. Flicker present if band amplitude >= 2.5x the within-step noise floor and >= 0.0004.
6. **Coherent model** (`coherent.ts`): mean_step = content + sum_h Re{z_h(E) phi_h(step) P_h}, with z_h the exposure-window average and phi_h the mean of e^{i 2 pi h f t} over the step's frames (capture times). Covers standing, drifting and rolling bands; band phase accumulates over the sweep, pinning f to ~0.1 / duration. Broad scan 40-330 Hz with the fundamental (incremental phase rotation, low-rank Gram), plus the null fit's candidates up to 3000 Hz (local scans), polished with 6 harmonics; best explained wins, integer-multiple ties go to the multiple, unless the null fit chose the lower one on purpose. **Trusted when its scan peak's significance (robust z) >= 15** and explained >= 0.3; then final (no refinement).
7. Otherwise refinement around the clean value nearest 180 deg that the sweep could measure (9 exposures, up and down, energies x exposure^2, symmetric V/U dip fit) against two content references (average of steps beyond the first null; centroid of the null steps), keeping the one with the lowest dip floor. Moves capped at 3%. Confident only if refined with null contrast >= 0.9; else reported as unclear.

### Known limits
- Weak dips + busy content (text) + hand shake: often "unclear". A plain grey screen fixes it (exact in tests).
- A sweep cut short by a bright screen leaves the null fit few nulls; the coherent model still pins the frequency (e2e `BRIGHT=3`: exact), the refinement fallback is weaker.
- Frequencies f and f +- 30 Hz look alike to the coherent model at 30 fps (only the exposure dependence separates them); noisy sweeps can confuse them.
- Fast-rolling bands (e.g. 360 Hz at 30.5 fps) give the coherent model little to work with; the null fit handles them.
- Real-device behaviour (timestamps, exposure latency, ISO support, noise) is unverified until the user's diagnostics come in.

## Testing
- `npm test`: unit + simulated measurements (`test/sim.ts`: 2D grid, tilt via `scan`, PWM/sine/dip, drift via `cameraFps`, `timeJitter`, content types; `brightness` = linear light per second x ISO, omitted = camera keeps brightness constant; `simCamera(opt, lag, step, ignoreIso)`).
- `npm run build && npm run e2e -- <Hz> <duty|sine> <fps>`: headless Chromium, real app with a synthetic camera (MediaStreamTrackGenerator with exact timestamps, sensor noise, gamma). Env: `PORTRAIT=1`, `TILT=1`, `JITTER=1` (hand shake), `CONTENT=plain`, `BRIGHT=<factor>` (brighter screen; 3 limits the sweep, 8 is too bright), `DUMP=<file>` (full data export).
- Diagnostics in the app: "Copy report" (caps, camera label + back cameras, timeSource, frame intervals, texture, result incl. calibration, limited, coherent candidates, per-step data incl. calibration steps) and "Download full data" (adds frame times and both channels' mean grids).
- Gotchas: don't `pkill -f vitest` from a shell whose command line contains the pattern; vitest prints console output only at the end (append to files for long runs); debug tests that import `node:fs` break `tsc` if left in `test/`.

## Stack / repo
TypeScript + Vite, no framework; `base: './'`; multi-page (`index.html`, `probe.html`, `target.html`). CSS: `[hidden]` is forced to `display: none` (`.row` etc. would override it). GitHub Pages deploy on push to `main` (tests run first). Work directly on `main`.
