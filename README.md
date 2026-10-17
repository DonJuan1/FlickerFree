# FlickerFree

Mobile web app (Chrome on Android) that finds the fastest shutter speed at which a screen filmed by the phone's camera shows no flicker bands.

Status: step 1, the camera probe (`probe.html`), which reports what exposure control Chrome exposes on the device.

```sh
npm install
npm run dev      # serves on the LAN; camera needs HTTPS or localhost
npm run build
```

Deployed to GitHub Pages on every push to `main`.
