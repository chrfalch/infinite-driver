// The engine's state for every physics step, from the physics (worker or main thread) to the audio
// thread. A ring of records in a SharedArrayBuffer: physics writes one record per step, the audio
// worklet reads them without any message in between. Physics runs in uneven batches (1–4 steps,
// sometimes late), so the audio plays the records a little behind the newest one and interpolates
// between them; values sent once per frame made the engine pitch step.

import { WHEEL_FIELDS, WHEELS, writeWheels } from './wheels.js';

// The engine's fields, then each wheel's (w0contact, w0ground, …; see wheels.js).
const ENGINE_FIELDS = ['time', 'rpm', 'throttle', 'fuel', 'exhaustBrake', 'clutch', 'speed', 'gear'];
export const FIELDS = [...ENGINE_FIELDS, ...Array.from({ length: WHEELS }, (_, i) => WHEEL_FIELDS.map((f) => `w${i}${f}`)).flat()];
const SURFACE_EVERY = 6; // steps between ground lookups per wheel
const STRIDE = FIELDS.length;
export const RECORDS = 512; // about 4 s at 120 steps per second
const HEADER = 8; // bytes: the count of records written (Int32), padded

export const feedSupported = () => typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated !== false;

// The buffer to share: SharedArrayBuffer when the page is cross-origin isolated, else a plain one
// (then only this thread can read it).
export function createFeedBuffer() {
  const bytes = HEADER + RECORDS * STRIDE * 8;
  return feedSupported() ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}

export class AudioFeed {
  constructor(buffer) {
    this.buffer = buffer;
    this.count = new Int32Array(buffer, 0, 1);
    this.data = new Float64Array(buffer, HEADER, RECORDS * STRIDE);
    this.shared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
  }

  written() {
    return this.shared ? Atomics.load(this.count, 0) : this.count[0];
  }

  // One record, in FIELDS order.
  write(values) {
    const n = this.written();
    this.data.set(values, (n % RECORDS) * STRIDE);
    if (this.shared) Atomics.store(this.count, 0, n + 1);
    else this.count[0] = n + 1;
  }

  // The record for a vehicle after a physics step at sim time t. heightAt (optional) gives the
  // ground under each wheel.
  writeStep(t, vehicle, heightAt = null) {
    const d = vehicle.drivetrain;
    if (!d) return;
    const r = (this.record ??= new Float64Array(STRIDE));
    r[0] = t;
    r[1] = d.rpm;
    r[2] = d.throttle ?? 0;
    r[3] = d.fuel ?? 0;
    r[4] = d.exhaustBrake ?? 0;
    r[5] = d.clutch ?? 0;
    r[6] = vehicle.speed ?? 0;
    r[7] = d.gear ?? 0;
    this.surfaces ??= Array.from({ length: WHEELS }, () => ({ rock: 0, gravel: 0 }));
    this.steps = (this.steps ?? 0) + 1;
    writeWheels(vehicle, r, ENGINE_FIELDS.length, heightAt, this.surfaces, this.steps % SURFACE_EVERY === 1);
    this.write(r);
  }

  // Record i (0 = oldest still kept) into out; returns false if it is no longer in the ring.
  read(i, out) {
    const n = this.written();
    if (i < n - RECORDS || i >= n) return false;
    const base = (i % RECORDS) * STRIDE;
    for (let k = 0; k < STRIDE; k++) out[k] = this.data[base + k];
    return true;
  }
}

// Reads the feed on the audio thread: a playhead in sim time that runs `latency` seconds behind the
// newest record at the audio clock's pace, sped up or slowed a little to hold that distance (sim
// time can run slower than the wall clock when physics drops time). The pitch comes from the rpm in
// the records, so the playhead's pace never changes the pitch. When physics stops (a hidden tab),
// the playhead waits at the newest record.
export class FeedReader {
  constructor(feed, { latency = 0.05 } = {}) {
    this.feed = feed;
    this.latency = latency;
    this.playhead = null;
    this.cursor = 0; // index of the record at or before the playhead
    this.a = new Float64Array(STRIDE);
    this.b = new Float64Array(STRIDE);
    this.newest = new Float64Array(STRIDE);
    this.values = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    this.hasData = false;
  }

  // Advance by dt seconds of audio; returns the interpolated values at the new playhead.
  advance(dt) {
    const feed = this.feed;
    const n = feed.written();
    if (n === 0 || !feed.read(n - 1, this.newest)) return this.values;
    const newestT = this.newest[0];
    const target = newestT - this.latency;
    // First data, a respawn that reset the clock, or far behind (after a stall): jump.
    if (this.playhead === null || Math.abs(target - this.playhead) > 0.3) {
      this.playhead = target;
      this.cursor = Math.max(0, n - RECORDS);
    } else {
      const error = target - this.playhead;
      const rate = Math.min(1.5, Math.max(0.5, 1 + error * 4));
      this.playhead = Math.min(newestT, this.playhead + dt * rate);
    }
    this.hasData = true;

    // Find the two records around the playhead.
    if (this.cursor < n - RECORDS) this.cursor = Math.max(0, n - RECORDS);
    if (!feed.read(this.cursor, this.a)) return this.values;
    if (this.a[0] > this.playhead) {
      // The playhead is before the cursor (it jumped back): search from the oldest record.
      this.cursor = Math.max(0, n - RECORDS);
      feed.read(this.cursor, this.a);
    }
    while (this.cursor + 1 < n && feed.read(this.cursor + 1, this.b) && this.b[0] <= this.playhead) {
      this.cursor++;
      this.a.set(this.b);
    }
    const v = this.values;
    if (this.cursor + 1 < n && feed.read(this.cursor + 1, this.b) && this.b[0] > this.a[0]) {
      const f = Math.min(1, Math.max(0, (this.playhead - this.a[0]) / (this.b[0] - this.a[0])));
      for (let k = 0; k < STRIDE; k++) v[FIELDS[k]] = this.a[k] + (this.b[k] - this.a[k]) * f;
      v.gear = this.a[7];
    } else {
      for (let k = 0; k < STRIDE; k++) v[FIELDS[k]] = this.a[k];
    }
    return v;
  }
}
