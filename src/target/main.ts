// Plain grey test image for the screen being measured. The level sets how bright the
// screen looks to the phone camera without touching the screen's brightness setting,
// which can change how the screen flickers (PWM dimming).

/** Grey levels in % of full code value; 20% suits a ~400 nit screen over the whole sweep. */
const LEVELS = [5, 10, 15, 20, 30, 40, 50, 70, 100];
const DEFAULT = 3;
const KEY = 'flickerfree.target';

const hint = document.getElementById('hint')!;
let index = DEFAULT;
try {
  const saved = Number(localStorage.getItem(KEY));
  if (saved && LEVELS.includes(saved)) index = LEVELS.indexOf(saved);
} catch {
  // Storage unavailable: keep the default.
}

let fadeTimer = 0;
function show(first = false) {
  const v = Math.round((LEVELS[index] / 100) * 255);
  document.body.style.background = `rgb(${v}, ${v}, ${v})`;
  hint.textContent = first
    ? `Grey ${LEVELS[index]}%. Tap the right side for brighter, the left side for darker. The first tap goes full screen.`
    : `Grey ${LEVELS[index]}%`;
  hint.classList.remove('faded');
  clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => hint.classList.add('faded'), first ? 5000 : 1500);
  try {
    localStorage.setItem(KEY, String(LEVELS[index]));
  } catch {
    // ignore
  }
}

function step(d: number) {
  index = Math.min(LEVELS.length - 1, Math.max(0, index + d));
  show();
}

let wakeLock: WakeLockSentinel | null = null;
async function keepAwake() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    // Not available: the screen may dim on its own timeout.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) void keepAwake();
});

document.addEventListener('click', (e) => {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    void document.documentElement.requestFullscreen().catch(() => {});
    void keepAwake();
    return;
  }
  step(e.clientX > window.innerWidth / 2 ? 1 : -1);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === '+') step(1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === '-') step(-1);
  else if (e.key === 'f') void document.documentElement.requestFullscreen?.().catch(() => {});
});

show(true);
