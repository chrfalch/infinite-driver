// The race start and the pause. With other cars on the road every car is held on the grid until
// a 3-2-1 countdown ends; anywhere, the game can be paused (physics, AI, particles and
// sound stop; the camera still turns).
//
// The clock runs on real time and stops while paused. `start()` begins the countdown (as the
// loading screen goes), after a short lead-in so the screen is gone by "3".

export const COUNTDOWN = 3; // s from "3" to "GO!"
export const GO_SHOWN = 0.8; // s "GO!" stays up
export const LEAD_IN = 0.6; // s between start() and "3"

// The pedals of a car held on the grid: no throttle, the handbrake on (the brake at a standstill
// would ask for reverse).
export const HOLD = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: true });

export function createRace({ countdown = true } = {}) {
  // 'waiting' (for start()), 'counting', 'racing'.
  const race = { phase: countdown ? 'waiting' : 'racing', t: countdown ? -LEAD_IN : Infinity, paused: false };
  race.start = () => {
    if (race.phase === 'waiting') race.phase = 'counting';
  };
  race.update = (dt) => {
    if (race.paused || race.phase === 'waiting' || race.t === Infinity) return;
    race.t += dt;
    if (race.phase === 'counting' && race.t >= COUNTDOWN) race.phase = 'racing';
  };
  // Every car stays on the grid until the countdown ends.
  race.held = () => race.phase !== 'racing';
  // What the countdown shows: '3', '2', '1', 'GO!' or null.
  race.label = () => {
    if (race.phase === 'counting') return race.t < 0 ? null : String(COUNTDOWN - Math.floor(race.t));
    return race.t >= COUNTDOWN && race.t < COUNTDOWN + GO_SHOWN ? 'GO!' : null;
  };
  race.setPaused = (paused) => (race.paused = !!paused);
  race.togglePause = () => race.setPaused(!race.paused);
  return race;
}
