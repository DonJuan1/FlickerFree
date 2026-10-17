# FlickerFree

Mobile web app (Chrome on Android) that finds the fastest shutter speed at which a screen filmed by the phone's camera shows no flicker bands.

Status: step 1, the camera probe, which reports what exposure control Chrome exposes on the device.

Live: https://donjuan1.github.io/FlickerFree/ (probe: https://donjuan1.github.io/FlickerFree/probe.html)

```sh
npm install
npm run dev      # serves on the LAN; camera needs HTTPS or localhost
npm run build
```

Deployed to GitHub Pages on every push to `main`.
