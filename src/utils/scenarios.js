// Arrival rates in cars/min per approach.
// Capacity constraint (see trafficSim.js HEADWAY/MIN_GREEN/MAX_GREEN): a single
// approach can never sustain more than ~30/min (100% dedicated green), a fixed
// 15s/15s cycle caps every approach at ~13/min, and adaptive can push a starved
// approach to ~23/min by leaning on MAX_GREEN. Rates here are picked to sit
// inside those ceilings so the fixed-vs-AI comparison stabilizes instead of
// both queues growing without bound.
export const SCENARIOS = {
  normal: {
    id: "normal",
    label: "평시",
    emoji: "🌤️",
    rates: { N: 9, S: 9, E: 8, W: 8 },
  },
  rush: {
    id: "rush",
    label: "출퇴근 러시아워",
    emoji: "🚗",
    rates: { N: 15, S: 13, E: 11, W: 10 },
  },
  skewed: {
    id: "skewed",
    label: "한쪽 방향 몰림",
    emoji: "🚧",
    rates: { N: 18, S: 4, E: 6, W: 4 },
  },
};

export const SCENARIO_LIST = Object.values(SCENARIOS);
