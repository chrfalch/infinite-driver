// The loading screen (#loading in index.html, shown before any script runs): a bar for the startup
// steps, what is happening, and a joke or two while it does. The little buggy's animations are CSS
// transforms, so they keep moving while the page is busy (shaders compile, chunks are built).
//
// Each step has a weight in the bar; set(key, fraction) moves it. When the game is ready to drive
// and the sound is decoded, a button asks for a tap or a key: that gesture is what lets the browser
// start the sound, so the drive starts with it. Without sound to start (off, unsupported, or a
// browser driven by a script), the screen goes as soon as everything is ready. No sound plays
// before then: main.js arms it in finish's start().
//
// A row of worlds to pick from sits under the title the whole time. Until one is picked nothing
// loads: the screen shows just the title, the buggy and the row (screen.levels).

const STEPS = { gpu: 0.12, world: 0.08, physics: 0.08, car: 0.04, terrain: 0.36, hud: 0.04, warmup: 0.12, sound: 0.16 };

const QUIPS = [
  'Inflating the tyres…',
  'Scattering rocks, carefully at random…',
  'Teaching the dust to fly…',
  'Checking the oil…',
  'Polishing the beadlocks…',
  'Convincing the sun to come up…',
  'Raking the gravel…',
  'Planting a few stubborn bushes…',
  'Tuning the V8, by ear…',
  'Losing the map, on purpose…',
  'Counting the pebbles (there are a lot)…',
  'Giving the hills a gentle nudge…',
  'Finding first gear…',
  'Wiping the bugs off the windscreen…',
];

// Frames drawn before the drive counts as smooth: the first few compile shaders.
const WARMUP_FRAMES = 12;
const SMOOTH_FRAMES = 4;
const SMOOTH_MS = 70;
const WARMUP_MAX_MS = 10000;

export function createLoadingScreen() {
  const root = document.getElementById('loading');
  if (!root) return null;
  const $ = (name) => root.querySelector(`.loading-${name}`);
  const fill = $('fill');
  const step = $('step');
  const detail = $('detail');
  const quip = $('quip');
  const go = $('go');
  const levels = $('levels');
  const progress = Object.fromEntries(Object.keys(STEPS).map((key) => [key, 0]));
  const details = {};
  let started = performance.now();

  let shown = -1;
  const showQuip = () => {
    let next = Math.floor(Math.random() * QUIPS.length);
    if (next === shown) next = (next + 1) % QUIPS.length;
    shown = next;
    quip.classList.remove('in');
    // Reflow, so the fade starts again.
    void quip.offsetWidth;
    quip.textContent = QUIPS[next];
    quip.classList.add('in');
  };
  let quipTimer;
  const begin = () => {
    started = performance.now();
    showQuip();
    quipTimer = setInterval(showQuip, 2600);
  };

  const render = () => {
    let total = 0;
    for (const [key, weight] of Object.entries(STEPS)) total += weight * Math.min(1, Math.max(0, progress[key]));
    fill.style.transform = `scaleX(${total.toFixed(3)})`;
    detail.textContent = Object.values(details).filter(Boolean).join('  ·  ');
  };

  const screen = {
    // label: what is happening now (the line under the bar).
    set(key, fraction, label) {
      progress[key] = fraction;
      if (label) step.textContent = label;
      render();
    },
    // A short note next to the others under the bar (e.g. "sounds 12/63"), or none.
    note(key, text) {
      details[key] = text;
      render();
    },
    // Lets the browser draw the screen before the next piece of work (also in a background tab,
    // where there are no animation frames).
    pause: () =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 50);
        requestAnimationFrame(() => {
          clearTimeout(timer);
          setTimeout(resolve, 0);
        });
      }),
  };

  // The worlds to pick from ({ label: mode }). With ask, nothing else shows until one is clicked
  // (`current`, the last one driven, marked as a hint); without, `current` is the one loading.
  // Resolves with the world to load, and the loading starts on the screen.
  screen.levels = (worlds, current, { ask = false } = {}) =>
    new Promise((resolve) => {
      const buttons = Object.entries(worlds).map(([label, mode]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'loading-level';
        button.textContent = label;
        if (mode === current) button.classList.add('last');
        button.addEventListener('click', () => {
          if (levels.classList.contains('picked')) return;
          button.setAttribute('aria-pressed', 'true');
          pick(mode, `Off to the ${label.toLowerCase()}`);
        });
        return button;
      });
      const pick = (mode, label) => {
        levels.classList.add('picked');
        root.classList.remove('asking');
        // Keys go to the drive prompt from here (the gesture there skips the picker's buttons).
        if (levels.contains(document.activeElement)) document.activeElement.blur();
        step.textContent = label;
        begin();
        resolve(mode);
      };
      levels.replaceChildren(...buttons);
      levels.hidden = false;
      if (ask) {
        root.classList.add('asking');
        step.textContent = 'Pick a world to drive';
      } else {
        buttons.find((b) => b.classList.contains('last'))?.setAttribute('aria-pressed', 'true');
        pick(current, 'Getting ready');
      }
    });

  // Called every frame of the game until the drive runs smoothly.
  let frames = 0;
  let smooth = 0;
  let firstFrame = 0;
  let lastFrame = 0;
  let warm;
  const warmed = new Promise((resolve) => (warm = resolve));
  screen.frame = (now) => {
    if (progress.warmup >= 1) return;
    if (!firstFrame) firstFrame = now;
    smooth = lastFrame && now - lastFrame < SMOOTH_MS ? smooth + 1 : 0;
    lastFrame = now;
    frames++;
    const done = (frames >= WARMUP_FRAMES && smooth >= SMOOTH_FRAMES) || now - firstFrame > WARMUP_MAX_MS;
    screen.set('warmup', done ? 1 : Math.min(0.95, frames / WARMUP_FRAMES), frames === 1 ? 'Compiling shaders' : undefined);
    if (done) warm();
  };

  // Resolves once the game is warmed up, the sound decoded (`sound`, a promise), and (if `prompt()`
  // says so then) the player tapped or pressed a key; then the screen fades away. start(gesture)
  // runs then: start(true) inside that gesture (taps and keys on the world picker do not count),
  // start(false) when there was no prompt.
  screen.finish = async ({ sound = Promise.resolve(), prompt = () => true, start = () => {} } = {}) => {
    await Promise.all([warmed, sound]);
    clearInterval(quipTimer);
    for (const key of Object.keys(STEPS)) progress[key] = 1;
    render();
    console.info(`[loading] ready in ${Math.round(performance.now() - started)} ms`);
    if (prompt()) {
      step.textContent = 'Ready when you are';
      quip.classList.remove('in');
      root.classList.add('ready');
      if (matchMedia('(pointer: coarse)').matches) go.textContent = 'Tap to drive';
      go.hidden = false;
      // The sound starts on the same gesture (audio.js listens on the window as well).
      await new Promise((resolve) => {
        const types = ['pointerdown', 'keydown'];
        const onGesture = (e) => {
          if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
          if (levels.contains(e.target)) return;
          for (const type of types) window.removeEventListener(type, onGesture, true);
          start(true);
          resolve();
        };
        for (const type of types) window.addEventListener(type, onGesture, true);
      });
    } else start(false);
    root.classList.add('gone');
    setTimeout(() => root.remove(), 700);
  };

  // A failed start: the error shows instead (start.js).
  screen.remove = () => {
    clearInterval(quipTimer);
    root.remove();
  };
  return screen;
}
