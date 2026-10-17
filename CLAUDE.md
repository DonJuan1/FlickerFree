# FlickerFree -- Project Knowledge

Mobile web app (Chrome on Android) that measures a flickering screen with the phone camera and tells the user which **shutter speed to set on their cinema camera** (ARRI / Sony / RED) so the screen doesn't flicker on film. Physics: banding vanishes when exposure = n / f_flicker, for any camera, so a value clean on the phone is clean on the cinema camera.

## Agreed scope (latest)
- **One screen, no manual settings**: live view with an outline of the analysed area, a project-fps picker (23.976/24/25/29.97/30/48/50/59.94/60, default 25, remembered), a Measure button, progress bar + Stop.
- **Result**: the clean shutter value closest to **180 degrees** at the project fps, shown as shutter speed with small steps (e.g. `1/48.1 s`) **and** shutter angle (`187.2 deg at 25 fps`); other clean values listed below; flicker frequency in small text. "No flicker detected" if nothing is found. No standard-step rounding.
- **Result range**: 360 degrees (1/fps) to 1/250. The **sweep** goes further, to at least 1/20, so low frequencies show two nulls.
- **No 120 fps**: exposure can't exceed the frame interval, and the measurement doesn't need it (rolling-shutter rows give kHz time resolution within one frame).
- **Platform**: Chrome on Android with manual `exposureTime` (+ optional `iso`). Anything else: clear "not supported" message, no fallback. Test device: OnePlus 7T (manual exposure confirmed via the probe).
- **Content**: arbitrary, screen fills the outline. Single user, English, all processing on device.
- `probe.html` stays as a diagnostics page (linked under Diagnostics).

## Pipeline (`src/lib/measure.ts`)
1. **ISO calibration** at the geometric-mean exposure: ISO adjusted until mean luma ~115; afterwards exposure x ISO is kept constant so every step has the same brightness.
2. **Coarse sweep**: exposures from 1/250 to max(1/20, 1/fps), ratio 1.025 (~100 steps), snapped to the device step. Per step: drop 5 frames (pipeline latency), keep 5. Steps with mean luma < 12 or > 2% clipped pixels are skipped.
3. **Fit** (`analysis.ts`):
   - Per frame: 4 strip profiles along the **sensor readout axis** (the frame's short side) -> log, minus linear trend.
   - Per step: `selfCov` (mean cross-strip covariance per frame) and per-strip mean profiles.
   - `SweepModel`: content-free squared distances between steps, `D_ij = selfCov_i + selfCov_j - 2 crossCov(mean_i, mean_j)`; static content cancels in log space, cross-strip covariance removes noise and per-strip content shifts. Interpolated in log exposure via the law of cosines.
   - `fitFlicker`: grid search over f; score = sum over predicted nulls n/f of log(antinode energy / null energy), energies measured against the centroid of the predicted nulls. Sub-harmonic check for two sources (PWM + refresh): prefer f/k when the shared nulls are clean and the others clearly aren't. Then `polishAnchors`.
   - `fitContent`: least-squares band model for **standing bands** (flicker locked to the phone's frame rate): mean_E = content + sum_k s_k(E) P_k + c_k(E) Q_k, s_k = sin b / b, c_k = (cos b - 1)/b, b = 2 pi k f E. Used when it explains >= 95% of band variance; gives refined f and a content estimate.
4. **Refinement** around the clean value closest to 180 degrees: 9 exposures in +-min(4%, 0.3/n), swept up then down (cancels settling lag), energies against the content estimate (or the null centroid), parabola vertex, up to 3 iterations. f = n / vertex.

### Why the two references
With standing bands, a uniform relative error in f puts every predicted null at the same relative offset, and all those profiles carry the **same** residual pattern, so comparing nulls with each other can't see the error. The band-model fit can. With rolling/fast-drifting bands the residual patterns differ per frame, and comparing nulls works.

### Known weak spot
**Slowly drifting bands** (beat ~0.001-0.01 Hz, e.g. 60.000 Hz monitor vs a phone at 30.002 fps): neither reference is exact; simulated errors 1-3%. Possible fix: run the phone at an unusual frame rate (e.g. 27 fps) during the sweep so common screen rates never lock; needs probe data on which frame rates Chrome honours.

## Accuracy (simulated, `test/robustness.test.ts` and scans)
Median error of the final shutter value ~0.04%, p90 ~0.14% across 50-960 Hz, sine/PWM, flat/structured content, locked and rolling bands, settling lag longer than the dropped frames.

## Stack / repo
- TypeScript + Vite, no framework. Multi-page build (`index.html` app, `probe.html` diagnostics), `base: './'`.
- `npm test` (vitest, simulator in `test/sim.ts`), `npm run build` (tsc + vite), `npm run e2e` (headless Chromium with a synthetic canvas camera that renders physically correct banding for the exposure/ISO the app sets; needs `npm run build` first).
- Deploy: GitHub Pages via `.github/workflows/deploy.yml` on push to `main` (runs tests first). Work directly on `main`.

## Camera notes (`src/lib/camera.ts`)
- `exposureTime` is in **100 microsecond units**.
- Chrome needs `exposureMode: 'manual'` applied in its own call before `exposureTime`.
- `applyConstraints` replaces the whole set: always resend base constraints plus the accumulated advanced set.
- Image-capture capabilities appear only after the camera runs: read after the first frame + 700 ms.
- Frame timestamps from `requestVideoFrameCallback` metadata (`captureTime`, else callback time).
- After a measurement the camera goes back to continuous auto exposure.
- Diagnostics: "Copy report" (compact JSON: caps, result, per-step energies) and "Download full data" (adds per-step strip profiles and frame times) for offline analysis.

## Testing gotchas
- Don't `pkill -f vitest` / `grep [d]ebug` from a shell whose own command line contains the pattern: it kills the shell. Use e.g. `pgrep -f "suppress-warning[s]"`.
- vitest prints test console output only at the end; for long debug runs append to a file.
