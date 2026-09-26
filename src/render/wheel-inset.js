import { TIRE } from '../tire/config.js';
import { CAR } from '../vehicle/config.js';

// Distance from a wheel's centre plane to the inner face of its rim. The knuckle, axle ends,
// steering arms and control arms are placed from this, so they meet the wheel with no gap.
export function rimInnerFace() {
  return CAR.softTires ? (TIRE.width * 0.85) / 2 : CAR.wheelWidth / 2;
}
