// Arc-length transit timing is independent of rendering and frame rate.
export function createTransitSchedule(
  points,
  stationIndices,
  speed = 22,
  dwell = 5,
) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(
      lengths[i - 1] +
        Math.hypot(...points[i].map((v, a) => v - points[i - 1][a])),
    );
  }
  const total = lengths.at(-1);
  const stops = stationIndices
    .map((index) => lengths[index])
    .sort((a, b) => a - b);
  const cycle = total / speed + stops.length * dwell;
  function atDistance(distance) {
    const d = ((distance % total) + total) % total;
    let lo = 0,
      hi = lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= d) lo = mid;
      else hi = mid;
    }
    const t = (d - lengths[lo]) / (lengths[hi] - lengths[lo]);
    const position = points[lo].map((v, a) => v + (points[hi][a] - v) * t);
    const tangent = points[hi].map((v, a) => v - points[lo][a]);
    const len = Math.hypot(...tangent);
    return { position, tangent: tangent.map((v) => v / len), distance: d };
  }
  function sample(time) {
    let phase = ((time % cycle) + cycle) % cycle,
      previous = 0;
    for (let i = 0; i < stops.length; i++) {
      const travel = (stops[i] - previous) / speed;
      if (phase < travel)
        return {
          ...atDistance(previous + phase * speed),
          doors: 0,
          station: -1,
        };
      phase -= travel;
      if (phase < dwell)
        return {
          ...atDistance(stops[i]),
          doors: Math.max(0, Math.min(1, phase / 0.55, (dwell - phase) / 0.55)),
          station: i,
        };
      phase -= dwell;
      previous = stops[i];
    }
    return { ...atDistance(previous + phase * speed), doors: 0, station: -1 };
  }
  return { sample, atDistance, total, cycle, stops, speed, dwell, points };
}
