export const REMOTE_EXTRAPOLATION_LIMIT_SECONDS = 0.18;
export const MAX_COALESCED_SNAPSHOT_EVENTS = 96;
const DURABLE_WORLD_EVENT_TYPES = new Set(['meteor', 'comet-spawn', 'comet-impact']);

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
    Math.max(0, Number(ageSeconds) || 0) + Math.max(0, Number(elapsedSeconds) || 0),
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
    event => event?.type === 'shot',
    event => !DURABLE_WORLD_EVENT_TYPES.has(event?.type),
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
  if (!Number.isFinite(targetTime)) return { time: current + step, target: null };
  const target = Math.max(0, targetTime) + step;
  const error = target - current;
  // A client that is far behind can safely jump forward. When it is ahead
  // (usually because the host stalled), slow or pause the local presentation
  // clock until authority catches up instead of rewinding time-based effects.
  if (error > 0.75) return { time: target, target };
  const rate = Math.min(2, Math.max(0, 1 + error * 2));
  return { time: current + step * rate, target };
}
