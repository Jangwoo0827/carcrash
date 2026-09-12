import { mulberry32 } from "./random";

export const APPROACHES = ["N", "S", "E", "W"];

export const PHASES = {
  NS: ["N", "S"],
  EW: ["E", "W"],
};

export const APPROACH_LABEL = { N: "북", S: "남", E: "동", W: "서" };
export const PHASE_LABEL = { NS: "남북", EW: "동서" };

const MIN_GREEN = 10; // seconds — every phase gets at least this much, no starvation
const MAX_GREEN = 40; // seconds — hard cap so one direction can't hog the light
const YELLOW_TIME = 2.5; // seconds
const HEADWAY = 2.0; // seconds to clear one car during green (~1800 veh/hr saturation flow)
// Red side must be this much MORE congested to justify switching early. Kept
// deliberately high: when both sides are simply oversaturated (heavy but even
// demand), a low threshold reacts to noise and thrashes between phases —
// every switch burns YELLOW_TIME with zero throughput, which can make the
// "smart" controller worse than a boring fixed cycle. Only switch early for a
// real imbalance, not a queue that's 2-3 cars ahead.
const GAP_THRESHOLD = 8;
const LOG_LIMIT = 8;

export const FIXED_GREEN = 15; // baseline fixed-time cycle half-length

function otherPhase(phase) {
  return phase === "NS" ? "EW" : "NS";
}

export function createSimState(seed) {
  return {
    time: 0,
    rng: mulberry32(seed),
    queues: { N: [], S: [], E: [], W: [] },
    phase: "NS",
    phaseElapsed: 0,
    yellow: false,
    yellowElapsed: 0,
    serviceTimer: { N: 0, S: 0, E: 0, W: 0 },
    lastSwitchReason: null,
    stats: {
      departed: { N: 0, S: 0, E: 0, W: 0 },
      totalWait: { N: 0, S: 0, E: 0, W: 0 },
      maxWait: 0,
      log: [],
    },
  };
}

function pushLog(state, message) {
  state.stats.log.push({ id: `${state.time.toFixed(1)}-${message}`, time: state.time, message });
  if (state.stats.log.length > LOG_LIMIT) state.stats.log.shift();
}

function switchPhase(state, reason) {
  state.yellow = true;
  state.yellowElapsed = 0;
  state.lastSwitchReason = reason ?? null;
  if (reason) pushLog(state, reason);
}

/**
 * All controllers share this shape: (state) => string | boolean.
 * A string means "switch now, and log this as the reason"; `true` means
 * switch now without logging; anything falsy means keep the phase going.
 */

/** Fixed-time controller: always green for the same duration, no awareness of queues. */
export function fixedController(state) {
  return state.phaseElapsed >= FIXED_GREEN;
}

/**
 * Adaptive controller: gap-out / max-out actuated control, the same principle
 * real "smart" signal controllers use — extend green while it's still being
 * used, cut it short once the queue clears, and never starve the other side.
 */
export function adaptiveController(state) {
  if (state.phaseElapsed < MIN_GREEN) return null;

  const green = PHASES[state.phase];
  const red = PHASES[otherPhase(state.phase)];
  const greenQueue = green.reduce((s, a) => s + state.queues[a].length, 0);
  const redQueue = red.reduce((s, a) => s + state.queues[a].length, 0);

  if (state.phaseElapsed >= MAX_GREEN) {
    return `${PHASE_LABEL[state.phase]} 방향 최대 녹색시간(${MAX_GREEN}s) 도달 → 전환`;
  }
  if (greenQueue === 0 && redQueue > 0) {
    return `${PHASE_LABEL[state.phase]} 방향 대기 차량 없음 → 조기 전환`;
  }
  if (redQueue - greenQueue >= GAP_THRESHOLD) {
    return `반대편 대기 ${redQueue}대 vs 현재 ${greenQueue}대 → ${PHASE_LABEL[otherPhase(state.phase)]}로 전환`;
  }
  return null;
}

export function stepSimulation(state, dt, { arrivalRates, controller }) {
  state.time += dt;

  for (const a of APPROACHES) {
    const rate = arrivalRates[a] ?? 0;
    let expected = (rate / 60) * dt;
    while (expected > 0) {
      const chunk = Math.min(expected, 1);
      if (state.rng() < chunk) state.queues[a].push(state.time);
      expected -= 1;
    }
  }

  if (state.yellow) {
    state.yellowElapsed += dt;
    if (state.yellowElapsed >= YELLOW_TIME) {
      state.yellow = false;
      state.yellowElapsed = 0;
      state.phase = otherPhase(state.phase);
      state.phaseElapsed = 0;
    }
  } else {
    state.phaseElapsed += dt;
    const decision = controller(state, dt);
    if (decision) switchPhase(state, typeof decision === "string" ? decision : null);
  }

  if (!state.yellow) {
    for (const a of PHASES[state.phase]) {
      state.serviceTimer[a] += dt;
      while (state.serviceTimer[a] >= HEADWAY && state.queues[a].length > 0) {
        state.serviceTimer[a] -= HEADWAY;
        const arrival = state.queues[a].shift();
        const wait = state.time - arrival;
        state.stats.departed[a]++;
        state.stats.totalWait[a] += wait;
        state.stats.maxWait = Math.max(state.stats.maxWait, wait);
      }
      if (state.queues[a].length === 0) state.serviceTimer[a] = 0;
    }
    for (const a of PHASES[otherPhase(state.phase)]) {
      state.serviceTimer[a] = 0;
    }
  }

  return state;
}

export function lightStateFor(state, approach) {
  const isGreenGroup = PHASES[state.phase].includes(approach);
  if (!isGreenGroup) return "red";
  return state.yellow ? "yellow" : "green";
}

export function queueLength(state, approach) {
  return state.queues[approach].length;
}

export function currentWaitOf(state, approach) {
  const q = state.queues[approach];
  if (q.length === 0) return 0;
  return state.time - q[0];
}

export function totalDeparted(state) {
  return APPROACHES.reduce((s, a) => s + state.stats.departed[a], 0);
}

export function totalWait(state) {
  return APPROACHES.reduce((s, a) => s + state.stats.totalWait[a], 0);
}

export function averageWait(state) {
  const departed = totalDeparted(state);
  if (departed === 0) return 0;
  return totalWait(state) / departed;
}

export function totalQueued(state) {
  return APPROACHES.reduce((s, a) => s + state.queues[a].length, 0);
}
