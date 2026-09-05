export const REMOTE_EXTRAPOLATION_LIMIT_SECONDS = 0.18;
export const MAX_COALESCED_SNAPSHOT_EVENTS = 96;
const DURABLE_WORLD_EVENT_TYPES = new Set([
  "meteor",
  "comet-spawn",
  "comet-impact",
]);

export function advanceNetworkTimer(timer, dt, hz) {
  const interval = 1 / hz;
  const remaining = (Number.isFinite(timer) ? timer : 0) - Math.max(0, dt || 0);
  if (remaining > 0) return { due: false, timer: remaining };
  // Preserve the fractional-frame overshoot so a nominal 20/30 Hz cadence
  // does not alias down to 15/22.5 Hz. Never schedule a catch-up burst.
  return { due: true, timer: Math.max(0, remaining + interval) };
}

export function boundedSnapshotLead(ageSeconds, elapsedSeconds, alive = true) {
  if (!alive) return 0;
  return Math.min(
    REMOTE_EXTRAPOLATION_LIMIT_SECONDS,
    Math.max(0, Number(ageSeconds) || 0) +
      Math.max(0, Number(elapsedSeconds) || 0),
  );
}

export function extrapolatedPosition(position, velocity, leadSeconds) {
  return {
    x: (Number(position?.x) || 0) + (Number(velocity?.x) || 0) * leadSeconds,
    y: (Number(position?.y) || 0) + (Number(velocity?.y) || 0) * leadSeconds,
    z: (Number(position?.z) || 0) + (Number(velocity?.z) || 0) * leadSeconds,
  };
}

export function coalesceSnapshotEvents(
  previous = [],
  incoming = [],
  limit = MAX_COALESCED_SNAPSHOT_EVENTS,
) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max) return [];
  const events = [...previous, ...incoming];
  let excess = events.length - max;
  if (excess <= 0) return events;

  // Tracers are cosmetic and by far the most frequent transient. Shed their
  // oldest entries first so kill, award, damage, and world-event feedback can
  // survive a short client stall. If critical events alone exceed the bound,
  // keep the newest ones while preserving their chronological order.
  let retained = events;
  for (const canDrop of [
    (event) => event?.type === "shot",
    (event) => !DURABLE_WORLD_EVENT_TYPES.has(event?.type),
    () => true,
  ]) {
    if (excess <= 0) break;
    const next = [];
    for (const event of retained) {
      if (excess > 0 && canDrop(event)) {
        excess--;
        continue;
      }
      next.push(event);
    }
    retained = next;
  }
  return retained;
}

export function advanceNetworkClock(currentTime, targetTime, dt) {
  const current = Math.max(0, Number(currentTime) || 0);
  const step = Math.max(0, Number(dt) || 0);
  if (!Number.isFinite(targetTime))
    return { time: current + step, target: null };
  const target = Math.max(0, targetTime) + step;
  const error = target - current;
  // A client that is far behind can safely jump forward. When it is ahead
  // (usually because the host stalled), slow or pause the local presentation
  // clock until authority catches up instead of rewinding time-based effects.
  if (error > 0.75) return { time: target, target };
  const rate = Math.min(2, Math.max(0, 1 + error * 2));
  return { time: current + step * rate, target };
}

export const INPUT_INTENT_TIMEOUT_MS = 250;
export const SHOT_MAX_AGE_MS = 1000;
export function freshInput(input, now) {
  return !!input && now - (input.receivedAt ?? now) <= INPUT_INTENT_TIMEOUT_MS;
}

// Render other players slightly in the past. On underflow, hold the last
// confirmed point instead of inventing motion through a wall or across a seam.
export class RemoteTimeline {
  constructor() {
    this.samples = [];
    this.delay = 0.1;
    this.cursor = -Infinity;
  }
  push(sample) {
    const last = this.samples.at(-1);
    if (
      last &&
      (sample.epoch !== last.epoch ||
        sample.alive !== last.alive ||
        sample.up.x*last.up.x + sample.up.y*last.up.y + sample.up.z*last.up.z < -.99 ||
        Math.hypot(
          sample.pos.x - last.pos.x,
          sample.pos.y - last.pos.y,
          sample.pos.z - last.pos.z,
        ) > 20)
    ) {
      this.samples = [];
      this.cursor = -Infinity;
    } else if (last && sample.time <= last.time) return;
    if (last && this.samples.length) {
      const jitter = Math.abs(
        sample.received - last.received - (sample.time - last.time),
      );
      const wanted = Math.min(0.22, 0.1 + jitter);
      this.delay += (wanted - this.delay) * (wanted > this.delay ? 0.5 : 0.025);
    }
    this.samples.push(sample);
    if (this.samples.length > 32) this.samples.shift();
  }
  sample(now) {
    if (!this.samples.length) return null;
    const dt = this.lastNow == null ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    const desired = Math.min(this.samples.at(-1).time, now - this.delay);
    this.cursor = Number.isFinite(this.cursor)
      ? Math.max(this.cursor, Math.min(desired, this.cursor + dt * 1.15))
      : desired;
    while (this.samples.length > 2 && this.samples[1].time <= this.cursor)
      this.samples.shift();
    const a = this.samples[0],
      b = this.samples[1] || a;
    const t =
      b.time > a.time
        ? Math.max(0, Math.min(1, (this.cursor - a.time) / (b.time - a.time)))
        : 0;
    const mix = (x, y) => x + (y - x) * t;
    const angleDelta = Math.atan2(
      Math.sin(b.yaw - a.yaw),
      Math.cos(b.yaw - a.yaw),
    );
    return {
      pos: {
        x: mix(a.pos.x, b.pos.x),
        y: mix(a.pos.y, b.pos.y),
        z: mix(a.pos.z, b.pos.z),
      },
      yaw: a.yaw + angleDelta * t,
      aim: {
        x: mix(a.aim?.x ?? 0, b.aim?.x ?? 0),
        y: mix(a.aim?.y ?? 0, b.aim?.y ?? 0),
        z: mix(a.aim?.z ?? -1, b.aim?.z ?? -1),
      },
      up: {
        x: mix(a.up.x, b.up.x),
        y: mix(a.up.y, b.up.y),
        z: mix(a.up.z, b.up.z),
      },
    };
  }
}

export function pendingAmmo(ammo, shots, ack) {
  const result = { ...ammo };
  for (const shot of shots || [])
    if (
      shot.seq > ack &&
      shot.weapon !== "blaster" &&
      Number.isFinite(result[shot.weapon])
    ) {
      result[shot.weapon] = Math.max(0, result[shot.weapon] - 1);
    }
  return result;
}

export function mergeShotRequests(current, incoming, ack = 0) {
  const bySeq = new Map(
    (current || []).filter((s) => s.seq > ack).map((s) => [s.seq, s]),
  );
  for (const s of incoming || [])
    if (Number.isSafeInteger(s.seq) && s.seq > ack && !bySeq.has(s.seq))
      bySeq.set(s.seq, s);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(0, 64);
}
