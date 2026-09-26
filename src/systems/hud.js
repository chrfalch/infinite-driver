import { HudLabel, Vehicle } from '../ecs/traits.js';

export function updateHud(world) {
  const car = world.queryFirst(Vehicle);
  if (!car) return;
  const vehicle = car.get(Vehicle);
  world.query(HudLabel).updateEach(([label]) => {
    if (!label.format) return;
    const next = label.format(vehicle);
    if (next !== label.text.text) label.text.text = next;
  });
}
