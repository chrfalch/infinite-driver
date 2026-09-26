import { onHardwareKey, pressVirtual, releaseVirtual } from '../systems/input.js';

// On-screen driving buttons for phones and tablets.
//
// Browsers cannot tell whether a hardware keyboard is attached, so this uses a heuristic: the
// buttons show on touch devices and after any touch, and hide after a real key press.
// ?touch=1 forces them on, ?touch=0 off.

const BUTTONS = [
  { code: 'ArrowLeft', label: '◀', area: 'left', title: 'Steer left' },
  { code: 'ArrowRight', label: '▶', area: 'right', title: 'Steer right' },
  { code: 'ArrowUp', label: '▲', area: 'gas', title: 'Accelerate' },
  { code: 'ArrowDown', label: '▼', area: 'brake', title: 'Brake / reverse' },
  { code: 'Space', label: 'Handbrake', area: 'hand', title: 'Handbrake', small: true },
];

export function isTouchDevice() {
  return (globalThis.matchMedia?.('(pointer: coarse)').matches ?? false) || (navigator.maxTouchPoints ?? 0) > 0;
}

export function createTouchControls({ onRespawn, onCamera } = {}) {
  const param = new URLSearchParams(location.search).get('touch');
  const root = document.createElement('div');
  root.className = 'touch-controls';
  root.setAttribute('aria-label', 'Driving controls');

  const bind = (button, press, release) => {
    const active = new Set();
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        button.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events (tests) have no capturable pointer.
      }
      active.add(e.pointerId);
      button.classList.add('down');
      press();
    });
    const end = (e) => {
      if (!active.delete(e.pointerId)) return;
      if (active.size === 0) {
        button.classList.remove('down');
        release();
      }
    };
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', end);
    button.addEventListener('lostpointercapture', end);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  };

  for (const b of BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `touch-btn area-${b.area}${b.small ? ' small' : ''}`;
    button.textContent = b.label;
    button.title = b.title;
    button.setAttribute('aria-label', b.title);
    bind(
      button,
      () => pressVirtual(b.code),
      () => releaseVirtual(b.code),
    );
    root.append(button);
  }
  const respawn = document.createElement('button');
  respawn.type = 'button';
  respawn.className = 'touch-btn area-respawn small';
  respawn.textContent = 'Respawn';
  respawn.setAttribute('aria-label', 'Respawn car');
  respawn.addEventListener('click', () => onRespawn?.());
  root.append(respawn);
  const camera = document.createElement('button');
  camera.type = 'button';
  camera.className = 'touch-btn area-camera small';
  camera.textContent = 'Follow cam';
  camera.setAttribute('aria-label', 'Toggle follow camera');
  camera.addEventListener('click', () => camera.classList.toggle('down', !!onCamera?.()));
  root.append(camera);
  document.body.append(root);

  const setVisible = (visible) => {
    root.classList.toggle('visible', visible);
    document.body.classList.toggle('touch-mode', visible);
    if (!visible) BUTTONS.forEach((b) => releaseVirtual(b.code));
  };

  if (param === '1') setVisible(true);
  else if (param === '0') setVisible(false);
  else {
    setVisible(isTouchDevice());
    // Any touch brings the buttons back; a real key press hides them.
    window.addEventListener('touchstart', () => setVisible(true), { passive: true });
    onHardwareKey(() => setVisible(false));
  }
  return { root, setVisible, isVisible: () => root.classList.contains('visible') };
}
