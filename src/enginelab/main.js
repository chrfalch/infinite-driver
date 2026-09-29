// Engine sound lab (engine-lab.html): the game's engine sound without the game, for tuning by ear.
// Drive and rev modes run the car's drivetrain here on a flat road (or in neutral) and feed the
// sound through the same audio feed as the game; manual mode sets the engine from the sliders.
import GUI from 'lil-gui';
import { createAudio } from '../audio/audio.js';
import { AUDIO, saveAudio } from '../audio/config.js';
import { AudioFeed, createFeedBuffer } from '../audio/feed.js';
import { DEFAULT_DRIVETRAIN, Drivetrain } from '../vehicle/drivetrain.js';

const DT = 1 / 120;
const R = 0.46;
const MASS = 1800;

const LAB = { mode: 'drive', rpm: 850, fuel: 0.13, exhaustBrake: 0, throttle: false, coastStop: 1 };
const feed = new AudioFeed(createFeedBuffer());
const audio = createAudio({ feed });
let drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN });
let v = 0;
let simTime = 0;
let held = false;

const reset = () => {
  drive = new Drivetrain({ ...DEFAULT_DRIVETRAIN, automatic: LAB.mode === 'drive', coastStop: LAB.coastStop });
  v = 0;
};

const gui = new GUI({ title: 'Engine sound' });
gui.domElement.classList.add('tuning');
gui.add(LAB, 'mode', ['drive', 'rev', 'manual']).name('Mode').onChange(() => {
  reset();
  if (LAB.mode !== 'manual') audio.node?.port.postMessage({ type: 'feed' });
});
gui.add(LAB, 'coastStop', 0, 1, 0.05).name('Exhaust brake (drive, rev)').onChange(reset);
const manual = gui.addFolder('Manual');
const manualValues = () => ({ rpm: LAB.rpm, fuel: LAB.fuel, exhaustBrake: LAB.exhaustBrake, throttle: LAB.throttle ? 1 : 0 });
manual.add(LAB, 'rpm', 0, 5600, 10).name('rpm');
manual.add(LAB, 'fuel', 0, 1, 0.01).name('Fuel (load)');
manual.add(LAB, 'exhaustBrake', 0, 1, 0.01).name('Exhaust brake');
manual.add(LAB, 'throttle').name('Throttle (lift = flutter)');
const levels = gui.addFolder('Levels');
levels.add(AUDIO, 'enabled').name('Sound on (M)').onChange(saveAudio).listen();
levels.add(AUDIO, 'volume', 0, 1, 0.01).name('Volume').onChange(saveAudio);
levels.add(AUDIO, 'engine', 0, 2, 0.05).name('Engine ×').onChange(saveAudio);
levels.add(AUDIO, 'turbo', 0, 3, 0.05).name('Turbo whistle ×').onChange(saveAudio);
levels.add(AUDIO, 'clatter', 0, 3, 0.05).name('Diesel clatter ×').onChange(saveAudio);

const THROTTLE_KEYS = ['KeyW', 'ArrowUp'];
window.addEventListener('keydown', (e) => THROTTLE_KEYS.includes(e.code) && (held = true));
window.addEventListener('keyup', (e) => THROTTLE_KEYS.includes(e.code) && (held = false));
window.addEventListener('blur', () => (held = false));
// The on-screen throttle, for phones.
const pedal = document.getElementById('throttle');
pedal.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  held = true;
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) pedal.addEventListener(type, () => (held = false));

// Physics steps on the wall clock, as the game does.
const readout = document.getElementById('readout');
let last = performance.now();
let acc = 0;
const frame = (now) => {
  acc = Math.min(acc + (now - last) / 1000, 0.1);
  last = now;
  while (acc >= DT) {
    acc -= DT;
    const throttle = held ? 1 : 0;
    const torques = drive.update(DT, { throttle, reverseRequest: false }, [v / R, v / R, v / R, v / R], v, R);
    if (LAB.mode === 'drive') {
      const force = torques.reduce((a, b) => a + b, 0) / R - 0.75 * v * Math.abs(v) - (v > 0.05 ? 0.018 * MASS * 9.81 : 0);
      v = Math.max(0, v + (force / (MASS + (4 * 3.5) / (R * R))) * DT);
    }
    simTime += DT;
    feed.writeStep(simTime, { drivetrain: drive, speed: v });
  }
  if (LAB.mode === 'manual') audio.node?.port.postMessage({ type: 'manual', values: manualValues() });
  else audio.update({ drivetrain: drive });
  const d = LAB.mode === 'manual' ? { ...manualValues(), label: '-' } : { rpm: drive.rpm, fuel: drive.fuel, exhaustBrake: drive.exhaustBrake, label: drive.label };
  readout.textContent = [
    `sound    ${audio.state}${audio.ctx ? ` (${audio.ctx.state}, ${audio.ctx.sampleRate} Hz)` : ''}${audio.manual ? ', per frame' : ''}`,
    `rpm      ${Math.round(d.rpm)}`,
    `gear     ${d.label}`,
    `fuel     ${d.fuel.toFixed(2)}`,
    `exh brk  ${d.exhaustBrake.toFixed(2)}`,
    `speed    ${(v * 3.6).toFixed(0)} km/h`,
  ].join('\n');
  requestAnimationFrame(frame);
};
reset();
requestAnimationFrame(frame);
