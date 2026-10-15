// The countdown's big numbers, the pause button (top left; Esc too), and the paused screen with a
// button to drive on. `onPause(paused)` is told when the player pauses or resumes.
export function createRaceHud(race, { onPause = () => {}, onCount = () => {} } = {}) {
  const pause = document.createElement('button');
  pause.type = 'button';
  pause.className = 'pause-button';
  pause.textContent = '❚❚';
  pause.title = 'Pause (Esc)';
  pause.setAttribute('aria-label', 'Pause');

  const count = document.createElement('div');
  count.className = 'race-count';
  count.setAttribute('aria-live', 'assertive');

  const screen = document.createElement('div');
  screen.className = 'pause-screen';
  const title = document.createElement('div');
  title.className = 'pause-title';
  title.textContent = 'Paused';
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.className = 'pause-resume';
  resume.textContent = 'Resume';
  const hint = document.createElement('div');
  hint.className = 'pause-hint';
  hint.textContent = 'Drag to look around · Esc to resume';
  screen.append(title, resume, hint);
  document.body.append(pause, count, screen);

  const set = (paused) => {
    if (race.paused === paused) return;
    race.setPaused(paused);
    onPause(paused);
  };
  // pointerdown would also reach the canvas and the touch buttons' window listeners; click is enough.
  pause.addEventListener('click', () => set(!race.paused));
  resume.addEventListener('click', () => set(false));
  const onKey = (e) => {
    if (e.code !== 'Escape' || e.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName)) return;
    set(!race.paused);
  };
  // A hidden tab pauses (the physics would only stop anyway); it stays paused when it comes back.
  const onVisibility = () => document.hidden && set(true);
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);

  let shown = null;
  const hud = {
    setPaused: set,
    // Per frame: the countdown's number and the pause screen.
    update() {
      const label = race.label();
      if (label !== shown) {
        shown = label;
        count.textContent = label ?? '';
        count.classList.toggle('go', label === 'GO!');
        // Restart the pop animation for each new number.
        count.classList.remove('pop');
        if (label) {
          void count.offsetWidth;
          count.classList.add('pop');
          onCount(label);
        }
      }
      count.classList.toggle('frozen', race.paused);
      screen.classList.toggle('visible', race.paused);
      pause.classList.toggle('active', race.paused);
      pause.textContent = race.paused ? '▶' : '❚❚';
      pause.setAttribute('aria-label', race.paused ? 'Resume' : 'Pause');
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      pause.remove();
      count.remove();
      screen.remove();
    },
  };
  return hud;
}
