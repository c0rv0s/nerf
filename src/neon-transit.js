// Route order: original Central street station, Vice Galleria roof, Laser Palms roof.
export const NEON_TRANSIT_CONTROLS = [
  [0,10,0],[-26,10,0],[-53,10,0],[-74,10,0],[-76,21,16],
  [-70,32,30],[-57,39,51],[-35,40,55],
  [-8,35.2,55],[-8,35.2,36],[-8,35.2,12],
  [0,40,0],
  [32,29.2,-12],[32,29.2,-35],[32,29.2,-54],
  [60,33,-52],[72,27,-32],[76,21,-16],[74,10,0],[53,10,0],[26,10,0],
];
export const NEON_TRANSIT_STATIONS = [
  {name:'CENTRAL',x:0,y:10,z:0,yaw:0,roofY:0,controlIndex:0,color:0xffc36d},
  {name:'VICE GALLERIA',x:-8,y:35.2,z:36,yaw:Math.PI/2,roofY:34,controlIndex:9,color:0xff438e},
  {name:'LASER PALMS',x:32,y:29.2,z:-35,yaw:Math.PI/2,roofY:28,controlIndex:13,color:0x42eced},
];

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
