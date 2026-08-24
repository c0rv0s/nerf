import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceNetworkClock,
  advanceNetworkTimer,
  boundedSnapshotLead,
  coalesceSnapshotEvents,
  extrapolatedPosition,
  REMOTE_EXTRAPOLATION_LIMIT_SECONDS,
} from '../src/network-sync.js';

function countSends(fps, hz, seconds = 10) {
  let timer = 0;
  let sends = 0;
  const dt = 1 / fps;
  for (let i = 0; i < fps * seconds; i++) {
    const next = advanceNetworkTimer(timer, dt, hz);
    timer = next.timer;
    if (next.due) sends++;
  }
  return sends;
}

test('network send cadence preserves frame overshoot', () => {
  for (const fps of [15, 24, 30, 45, 60, 120]) {
    for (const hz of [20, 30]) {
      const expected = Math.min(fps, hz) * 10;
      assert.ok(
        Math.abs(countSends(fps, hz) - expected) <= 1,
        `${fps} fps should publish close to ${hz} Hz when possible`,
      );
    }
  }
});

test('remote extrapolation uses bounded snapshot age and velocity', () => {
  const lead = boundedSnapshotLead(0.08, 0, true);
  assert.equal(lead, 0.08);
  assert.deepEqual(
    extrapolatedPosition({ x: 1, y: 2, z: 3 }, { x: 10, y: 0, z: -5 }, lead),
    { x: 1.8, y: 2, z: 2.6 },
  );
  assert.equal(
    boundedSnapshotLead(0.5, 0.2, true),
    REMOTE_EXTRAPOLATION_LIMIT_SECONDS,
  );
  assert.equal(boundedSnapshotLead(0.08, 0.05, false), 0);
});

test('snapshot coalescing keeps newest state events and sheds old tracers first', () => {
  const previous = [
    { type: 'shot', id: 'old-shot' },
    { type: 'damage', id: 'damage' },
    { type: 'shot', id: 'newer-shot' },
  ];
  const incoming = [
    { type: 'kill', id: 'kill' },
    { type: 'award', id: 'award' },
  ];
  assert.deepEqual(
    coalesceSnapshotEvents(previous, incoming, 4).map(event => event.id),
    ['damage', 'newer-shot', 'kill', 'award'],
  );
  assert.deepEqual(
    coalesceSnapshotEvents(previous, incoming, 2).map(event => event.id),
    ['kill', 'award'],
  );
  assert.deepEqual(
    coalesceSnapshotEvents([
      { type: 'damage', id: 'damage' },
      { type: 'meteor', id: 'meteor' },
      { type: 'kill', id: 'kill' },
      { type: 'comet-impact', id: 'comet' },
    ], [], 2).map(event => event.id),
    ['meteor', 'comet'],
  );
});

test('network world clock snaps forward but catches backward drift without rewinding', () => {
  assert.deepEqual(advanceNetworkClock(1, 3, 0.05), { time: 3.05, target: 3.05 });

  let current = 3;
  let target = 1;
  for (let i = 0; i < 20; i++) {
    const next = advanceNetworkClock(current, target, 0.05);
    assert.ok(next.time >= current);
    current = next.time;
    target = next.target;
  }
  assert.equal(current, 3);
  assert.ok(Math.abs(target - 2) < 1e-9);

  for (let i = 0; i < 40; i++) {
    const next = advanceNetworkClock(current, target, 0.05);
    assert.ok(next.time >= current);
    current = next.time;
    target = next.target;
  }
  assert.ok(Math.abs(current - target) < 0.1);
});
