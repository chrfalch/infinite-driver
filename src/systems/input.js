import { CONTROLS } from '../controls.js';
import { Input, IsPlayer, Vehicle } from '../ecs/traits.js';
import { DRIVETRAIN, saveDrivetrain } from '../vehicle/config.js';
import { isTyping } from '../tuning/panel.js';

const keys = new Set();
// Keys held through the on-screen touch buttons.
const virtualKeys = new Set();
// Fresh presses since the last frame (key repeat is ignored).
const taps = new Set();
// Listeners told about the first real key press (used to hide the touch buttons).
const hardwareKeyListeners = new Set();

export function onHardwareKey(listener) {
  hardwareKeyListeners.add(listener);
  return () => hardwareKeyListeners.delete(listener);
}

export function pressVirtual(code) {
  if (!virtualKeys.has(code)) taps.add(code);
  virtualKeys.add(code);
}

export function releaseVirtual(code) {
  virtualKeys.delete(code);
}

const ACCELERATOR = ['KeyW', 'ArrowUp'];
const BRAKE = ['KeyS', 'ArrowDown'];

export function attachKeyboard(target = window) {
  const down = (e) => {
    // Keys typed into the tuning panel must not drive the car.
    if (isTyping(e)) return;
    if (!e.repeat) taps.add(e.code);
    keys.add(e.code);
    hardwareKeyListeners.forEach((listener) => listener(e));
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

const pressed = (...codes) => codes.some((c) => keys.has(c) || virtualKeys.has(c));
const tapped = (...codes) => codes.some((c) => taps.has(c));

export function readInput(world) {
  const input = world.get(Input);
  if (CONTROLS.latchAccelerator) {
    // Tap to latch the engine on, tap again to switch it off.
    if (tapped(...ACCELERATOR)) input.engineOn = !input.engineOn;
  } else {
    // The engine drives while the accelerator is held; releasing it gives engine braking.
    input.engineOn = pressed(...ACCELERATOR);
  }
  input.brake = pressed(...BRAKE) ? 1 : 0;
  if (input.brake) input.engineOn = false;
  input.throttle = input.engineOn ? 1 : 0;
  // Positive steer turns left.
  input.steer = (pressed('KeyA', 'ArrowLeft') ? 1 : 0) - (pressed('KeyD', 'ArrowRight') ? 1 : 0);
  input.handbrake = pressed('Space');

  // Gearbox keys: Q / E shift down / up (and switch to manual), L toggles low range when slow.
  const car = world.queryFirst(IsPlayer, Vehicle);
  const vehicle = car?.get(Vehicle);
  if (vehicle?.drivetrain) {
    if (tapped('KeyE', 'KeyQ')) {
      if (DRIVETRAIN.automatic) {
        DRIVETRAIN.automatic = false;
        saveDrivetrain();
      }
      if (tapped('KeyE')) vehicle.drivetrain.shiftUp();
      else vehicle.drivetrain.shiftDown();
    }
    if (tapped('KeyL') && Math.abs(vehicle.speed) < 3) {
      DRIVETRAIN.low = !DRIVETRAIN.low;
      saveDrivetrain();
    }
  }
  taps.clear();
}
