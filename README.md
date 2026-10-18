# FlickerFree

Point an Android phone (Chrome) at a flickering screen, tap **Measure**, and get the shutter speed and shutter angle to set on your cinema camera so the screen doesn't flicker on film.

Live: https://donjuan1.github.io/FlickerFree/ · grey test image for the screen: https://donjuan1.github.io/FlickerFree/target.html · camera diagnostics: https://donjuan1.github.io/FlickerFree/probe.html

How it works: the phone sweeps its own exposure from 1/250 to 1/20 and records how the screen's banding changes; a model of the bands over the whole sweep (using each frame's capture time) pins down the flicker frequency, from which the clean shutter values (exposure = n / frequency) follow. Frames are aligned against hand shake and the analysis works with tilted bands (OLED screens). Brightness is calibrated with ISO and exposure; a screen too bright for the phone at slow shutter speeds is measured over the part it can, or the app asks for a darker grey image. It uses the main back camera (another lens can be picked). Best results with a plain grey image on the screen at the brightness setting you'll shoot with. Details in `CLAUDE.md`.

```sh
npm install
npm test         # unit + simulated end-to-end measurement tests
npm run build
npm run e2e -- 90.83 0.985 25   # headless Chromium, synthetic flickering camera (after build)
npm run dev      # LAN dev server; the camera needs HTTPS or localhost
```

Deployed to GitHub Pages on every push to `main`.
