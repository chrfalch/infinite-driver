import { Input } from '../ecs/traits.js';

const keys = new Set();

export function attachKeyboard(target = window) {
  const down = (e) => {
    keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };
  const up = (e) => keys.delete(e.code);
  const blur = () => keys.clear();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
  };
}

const pressed = (...codes) => codes.some((c) => keys.has(c));

export function readInput(world) {
  const input = world.get(Input);
  input.throttle = pressed('KeyW', 'ArrowUp') ? 1 : 0;
  input.brake = pressed('KeyS', 'ArrowDown') ? 1 : 0;
  // Positive steer turns left.
  input.steer = (pressed('KeyA', 'ArrowLeft') ? 1 : 0) - (pressed('KeyD', 'ArrowRight') ? 1 : 0);
  input.handbrake = pressed('Space');
}
