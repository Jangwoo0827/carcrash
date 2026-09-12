import { mulberry32 } from "./random";
import { APPROACHES, MOVEMENT_TARGET, buildPath } from "./geometry";

export { APPROACHES };

export const PHASES = {
  NS: ["N", "S"],
  EW: ["E", "W"],
};

export const APPROACH_LABEL = { N: "북", S: "남", E: "동", W: "서" };
export const PHASE_LABEL = { NS: "남북", EW: "동서" };

const MIN_GREEN = 10; // seconds — every phase gets at least this much, no starvation
const MAX_GREEN = 40; // seconds — hard cap so one direction can't hog the light
const YELLOW_TIME = 2.5; // seconds
const HEADWAY_THROUGH = 2.0; // seconds to clear one through car (~1800 veh/hr)
const HEADWAY_TURN = 2.6; // turning vehicles clear the stop line a bit slower
// Red side must be this much MORE congested to justify switching early. Kept
// deliberately high: when both sides are simply oversaturated (heavy but even
// demand), a low threshold reacts to noise and thrashes between phases —
// every switch burns YELLOW_TIME with zero throughput, which can make the
// "smart" controller worse than a boring fixed cycle. Only switch early for a
// real imbalance, not a queue that's 2-3 cars ahead.
const GAP_THRESHOLD = 8;
const LOG_LIMIT = 8;

const CROSS_DURATION = { through: 1.8, left: 2.6, right: 2.2, uturn: 3.0 };
// Movement mix for newly-arriving traffic on any approach.
const MOVEMENT_WEIGHTS = [
  ["through", 0.65],
  ["right", 0.2],
  ["left", 0.12],
  ["uturn", 0.03],
];
const LANE_OF = { through: "through", left: "left", right: "right", uturn: "left" };

const PED_RATE_PER_MIN = 7; // pedestrians/min per leg, while that crosswalk is walkable
const PED_DURATION = 3.2; // seconds to cross

export const FIXED_GREEN = 15; // baseline fixed-time cycle half-length

function otherPhase(phase) {
  return phase === "NS" ? "EW" : "NS";
}

function oppositeApproach(a) {
  return { N: "S", S: "N", E: "W", W: "E" }[a];
}

function pickMovement(rng) {
  const r = rng();
  let acc = 0;
  for (const [name, weight] of MOVEMENT_WEIGHTS) {
    acc += weight;
    if (r < acc) return name;
  }
  return "through";
}

export function createSimState(seed) {
  const emptyLanes = () => ({ through: [], left: [], right: [] });
  const zeroLanes = () => ({ through: 0, left: 0, right: 0 });
  return {
    time: 0,
    rng: mulberry32(seed),
    nextId: 1,
    queues: { N: emptyLanes(), S: emptyLanes(), E: emptyLanes(), W: emptyLanes() },
    serviceTimer: { N: zeroLanes(), S: zeroLanes(), E: zeroLanes(), W: zeroLanes() },
    crossing: [],
    pedestrians: { N: [], S: [], E: [], W: [] },
    phase: "NS",
    phaseElapsed: 0,
    yellow: false,
    yellowElapsed: 0,
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
 * What the controllers reason about: through-lane demand only. Left-turners
 * can sit queued waiting for a gap in oncoming traffic no matter how long the
 * green runs, so counting them here would make a permissive left with heavy
 * opposing traffic look like "still congested, keep extending" — wasting
 * green time on a lane that extra time can't actually help. Real actuated
 * controllers key off through-lane detectors for the same reason.
 */
export function approachQueueLength(state, approach) {
  return state.queues[approach].through.length;
}

/** Every vehicle currently waiting at this approach, across all lanes. */
export function totalApproachQueue(state, approach) {
  const q = state.queues[approach];
  return q.through.length + q.left.length + q.right.length;
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
  const greenQueue = green.reduce((s, a) => s + approachQueueLength(state, a), 0);
  const redQueue = red.reduce((s, a) => s + approachQueueLength(state, a), 0);

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

export function crosswalkWalkable(state, leg) {
  if (state.yellow) return false;
  return leg === "N" || leg === "S" ? state.phase === "EW" : state.phase === "NS";
}

export function isCrosswalkOccupied(state, leg) {
  return state.pedestrians[leg].some((p) => p.progress > 0.02 && p.progress < 0.98);
}

function departVehicle(state, approach, lane) {
  const item = state.queues[approach][lane].shift();
  const path = buildPath(approach, item.movement);
  state.crossing.push({
    id: item.id,
    approach,
    movement: item.movement,
    path,
    progress: 0,
    duration: CROSS_DURATION[item.movement],
    spawnTime: item.spawnTime,
    crossStart: state.time,
  });
}

export function stepSimulation(state, dt, { arrivalRates, controller }) {
  state.time += dt;

  // 1. Vehicle arrivals
  for (const a of APPROACHES) {
    const rate = arrivalRates[a] ?? 0;
    let expected = (rate / 60) * dt;
    while (expected > 0) {
      const chunk = Math.min(expected, 1);
      if (state.rng() < chunk) {
        const movement = pickMovement(state.rng);
        state.queues[a][LANE_OF[movement]].push({ id: state.nextId++, spawnTime: state.time, movement });
      }
      expected -= 1;
    }
  }

  // 2. Signal phase / yellow transition
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

  // 3. Through-lane departures (only while this approach's phase is green)
  for (const a of APPROACHES) {
    const isGreen = !state.yellow && PHASES[state.phase].includes(a);
    if (!isGreen) {
      state.serviceTimer[a].through = 0;
      continue;
    }
    state.serviceTimer[a].through += dt;
    while (state.serviceTimer[a].through >= HEADWAY_THROUGH && state.queues[a].through.length > 0) {
      state.serviceTimer[a].through -= HEADWAY_THROUGH;
      departVehicle(state, a, "through");
    }
    if (state.queues[a].through.length === 0) state.serviceTimer[a].through = 0;
  }

  // 4. Left-lane departures: gated by the same green, but only when the
  // opposing approach isn't currently sending a car through the box (a rough
  // stand-in for "yield to oncoming traffic, take the gap when it appears").
  for (const a of APPROACHES) {
    const isGreen = !state.yellow && PHASES[state.phase].includes(a);
    const opp = oppositeApproach(a);
    const oppOccupied = state.crossing.some(
      (v) => v.approach === opp && (v.movement === "through" || v.movement === "right")
    );
    if (!isGreen || oppOccupied) {
      state.serviceTimer[a].left = 0;
      continue;
    }
    state.serviceTimer[a].left += dt;
    while (state.serviceTimer[a].left >= HEADWAY_TURN && state.queues[a].left.length > 0) {
      state.serviceTimer[a].left -= HEADWAY_TURN;
      departVehicle(state, a, "left");
    }
    if (state.queues[a].left.length === 0) state.serviceTimer[a].left = 0;
  }

  // 5. Right turns flow independently of the signal, yielding only to a
  // pedestrian currently in the crosswalk they'd cross.
  for (const a of APPROACHES) {
    const exitLeg = MOVEMENT_TARGET[a].right;
    if (isCrosswalkOccupied(state, exitLeg)) continue;
    state.serviceTimer[a].right += dt;
    while (state.serviceTimer[a].right >= HEADWAY_TURN && state.queues[a].right.length > 0) {
      state.serviceTimer[a].right -= HEADWAY_TURN;
      departVehicle(state, a, "right");
    }
    if (state.queues[a].right.length === 0) state.serviceTimer[a].right = 0;
  }

  // 6. Advance vehicles already crossing the box
  for (let i = state.crossing.length - 1; i >= 0; i--) {
    const v = state.crossing[i];
    v.progress += dt / v.duration;
    if (v.progress >= 1) {
      const wait = v.crossStart - v.spawnTime;
      state.stats.departed[v.approach]++;
      state.stats.totalWait[v.approach] += wait;
      state.stats.maxWait = Math.max(state.stats.maxWait, wait);
      state.crossing.splice(i, 1);
    }
  }

  // 7. Pedestrians: spawn while their crosswalk is walkable, advance while crossing
  for (const leg of APPROACHES) {
    if (crosswalkWalkable(state, leg)) {
      let expected = (PED_RATE_PER_MIN / 60) * dt;
      while (expected > 0) {
        const chunk = Math.min(expected, 1);
        if (state.rng() < chunk) state.pedestrians[leg].push({ id: state.nextId++, progress: 0 });
        expected -= 1;
      }
    }
    const peds = state.pedestrians[leg];
    for (let i = peds.length - 1; i >= 0; i--) {
      peds[i].progress += dt / PED_DURATION;
      if (peds[i].progress >= 1) peds.splice(i, 1);
    }
  }

  return state;
}

export function lightStateFor(state, approach) {
  const isGreenGroup = PHASES[state.phase].includes(approach);
  if (!isGreenGroup) return "red";
  return state.yellow ? "yellow" : "green";
}

export function currentWaitOf(state, approach) {
  const q = state.queues[approach];
  const all = [...q.through, ...q.left, ...q.right];
  if (all.length === 0) return 0;
  let oldest = all[0].spawnTime;
  for (const v of all) if (v.spawnTime < oldest) oldest = v.spawnTime;
  return state.time - oldest;
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
  return APPROACHES.reduce((s, a) => s + totalApproachQueue(state, a), 0);
}
