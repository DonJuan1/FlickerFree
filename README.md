# FlickerFree

Point an Android phone (Chrome) at a flickering screen, tap **Measure**, and get the shutter speed and shutter angle to set on your cinema camera so the screen doesn't flicker on film.

Live: https://donjuan1.github.io/FlickerFree/ · camera diagnostics: https://donjuan1.github.io/FlickerFree/probe.html

How it works: the phone sweeps its own exposure from 1/250 to 1/20 and finds where rolling-shutter banding disappears (exposure = n / flicker frequency), works out the flicker frequency, then refines the clean value closest to 180 degrees at the project frame rate. Details in `CLAUDE.md`.

```sh
npm install
npm test         # unit + simulated end-to-end measurement tests
npm run build
npm run e2e      # headless Chromium with a synthetic flickering camera (after build)
npm run dev      # LAN dev server; the camera needs HTTPS or localhost
```

Deployed to GitHub Pages on every push to `main`.
