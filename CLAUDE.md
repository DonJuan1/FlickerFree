# FlickerFree -- Project Knowledge

Mobile web app that finds the **fastest exposure time (shutter speed) on the phone's own camera at which a filmed screen shows no flicker bands**. Output is the shutter speed only; the app records no video.

## Agreed scope
- **Platform**: Chrome on Android only (needs `exposureMode: 'manual'` + `exposureTime` via `applyConstraints`). Everything else gets a clear "not supported" screen, no fallback. iOS/WebKit exposes no exposure control.
- **Test device**: OnePlus 7T.
- **Targets**: monitors/laptops/TVs and phone/tablet OLEDs (roughly 50 Hz to a few kHz flicker; PWM dimming and refresh scanning).
- **Method (design A, sweep)**: rolling-shutter banding vanishes when exposure = n / f_flicker. Sweep exposure from short to long, measure band strength, the first null is the answer. Refine around the null by fitting (sub-step precision). Combined sources (PWM + refresh) are handled naturally: first exposure where all bands vanish.
- **Content**: arbitrary, possibly moving. Detect flicker as row patterns coherent across all columns (all pixels in a sensor row share exposure timing), over several frames per step.
- **Framing**: screen fills the camera view; analyse the centre region. No ROI or auto-detect.
- **Flow**: live view + live band-strength meter; "Measure" runs the sweep, refines until stable, progress bar + Stop.
- **Result**: exact value, e.g. `1/239.6 s (4.17 ms)`. No standard-step rounding. If no bands at any exposure: "No flicker detected" plus the fastest exposure tested.
- **Audience**: single user, English, no onboarding. All processing on device.

## Build order
1. `probe.html` -- capability probe (done): reports caps/settings, manual sliders, exposure response test, copyable JSON report.
2. Band-detection core + tests on synthetic data.
3. Live meter.
4. Sweep, refinement, result screen.

## Stack / repo
- TypeScript + Vite, no framework. Multi-page build (`index.html`, `probe.html`), `base: './'`.
- Deploy: GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. Work directly on `main`.
- `npm run build` = `tsc --noEmit && vite build`.

## Technical notes
- `exposureTime` is in **100 microsecond units** (spec). Verify on device with the probe's luma/ms column.
- Chrome needs `exposureMode: 'manual'` applied in a separate call before `exposureTime`.
- `applyConstraints` replaces the whole constraint set: always resend base constraints (size, frameRate, device) plus the accumulated advanced image-capture set.
- Chrome Android may report image-capture capabilities only after the camera runs; the probe reads them ~700 ms after start (and has a re-read button).
- Band direction follows the **sensor** rows; in portrait the displayed frame is rotated, so bands can show along either image axis. Analyse both.
- Shorter exposures darken the image; ISO compensation may be needed for SNR.
- Room lighting (100 Hz in 50 Hz mains regions) also bands; the screen should fill the frame.

## Testing without a phone
Headless Chromium with a fake camera: `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m` (synthetic banded Y4M). Manual-exposure capabilities can be mocked by patching `MediaStreamTrack.prototype.getCapabilities/getSettings/applyConstraints` in an init script. Real exposure behaviour can only be verified on the device.
