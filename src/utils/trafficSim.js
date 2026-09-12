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
const LOG_LIMIT = 10;
const EWMA_TAU = 10; // seconds — smoothing window for the AI's own arrival-rate estimate
const LOOKAHEAD = 8; // seconds — how far ahead the AI projects queue growth
const STARVATION_LIMIT = 55; // seconds — nobody should wait longer than this, no matter what
const THOUGHT_INTERVAL = 6; // seconds between "still thinking" log entries while holding a phase

// Mini-MPC: rather than only reacting to the current queue snapshot, actually
// clone the state and fast-forward it a few seconds under each candidate
// action, then act on whichever candidate produced less total wait. This is
// deliberately simple (a single "switch now" vs "keep going" comparison, no
// recursive re-planning inside the horizon) — a full receding-horizon
// controller would re-plan every step, but re-evaluating this often would
// dominate the frame budget at high replay speeds for a benefit that's
// mostly noise at a 10-15s horizon anyway.
const PLAN_HORIZON = 24; // seconds simulated forward per candidate
const PLAN_STEP = 1; // seconds per coarse step inside the projection
const PLAN_INTERVAL = 4; // seconds between re-evaluating the plan
const PLAN_MARGIN = 0.85; // switching must beat holding by at least ~15% to act (avoids noise-driven flapping)

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
    arrivalEwma: { N: 0, S: 0, E: 0, W: 0 },
    confidence: 50,
    lastThoughtAt: -THOUGHT_INTERVAL,
    lastPlanAt: -PLAN_INTERVAL,
    queueSnapshot: { N: 0, S: 0, E: 0, W: 0 },
    stats: {
      departed: { N: 0, S: 0, E: 0, W: 0 },
      totalWait: { N: 0, S: 0, E: 0, W: 0 },
      maxWait: 0,
      log: [],
    },
  };
}

function pushLog(state, message, kind = "switch") {
  state.stats.log.push({ id: `${state.time.toFixed(2)}-${message}`, time: state.time, message, kind });
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

function trendArrow(current, previous) {
  if (current > previous) return "↑";
  if (current < previous) return "↓";
  return "→";
}

/** The AI's own estimate of arrivals/sec, projected `seconds` into the future. */
function forecastQueueLength(state, approach, seconds) {
  return approachQueueLength(state, approach) + state.arrivalEwma[approach] * seconds;
}

function oldestThroughWait(state, approach) {
  const q = state.queues[approach].through;
  if (q.length === 0) return 0;
  let oldest = q[0].spawnTime;
  for (const v of q) if (v.spawnTime < oldest) oldest = v.spawnTime;
  return state.time - oldest;
}

/** Bigger imbalance (either direction) = the AI is more sure its current call is right. */
function computeConfidence(greenQueue, redQueue) {
  return Math.max(8, Math.min(97, Math.round(50 + Math.abs(redQueue - greenQueue) * 6)));
}

function logThought(state, greenQueue, redQueue, plan) {
  if (state.time - state.lastThoughtAt < THOUGHT_INTERVAL) return;
  state.lastThoughtAt = state.time;

  const green = PHASES[state.phase];
  const red = PHASES[otherPhase(state.phase)];
  const prev = state.queueSnapshot;
  const greenTrend = green
    .map((a) => `${APPROACH_LABEL[a]}${approachQueueLength(state, a)}대${trendArrow(approachQueueLength(state, a), prev[a])}`)
    .join(" ");
  const redTrend = red
    .map((a) => `${APPROACH_LABEL[a]}${approachQueueLength(state, a)}대${trendArrow(approachQueueLength(state, a), prev[a])}`)
    .join(" ");
  const redForecast = plan ? plan.redForecast : red.reduce((s, a) => s + forecastQueueLength(state, a, LOOKAHEAD), 0);
  const inflowPct = redQueue > 0 ? Math.round(((redForecast - redQueue) / redQueue) * 100) : redForecast > 0 ? 100 : 0;
  const planNote = plan
    ? ` · 가상실행: 유지 ${plan.costHold.toFixed(0)} vs 전환 ${plan.costSwitch.toFixed(0)}`
    : "";

  for (const a of APPROACHES) state.queueSnapshot[a] = approachQueueLength(state, a);

  pushLog(
    state,
    `[${PHASE_LABEL[state.phase]} 진행 ${Math.floor(state.phaseElapsed)}s] 현재측 ${greenTrend} · 반대측 ${redTrend} (${LOOKAHEAD}초 후 예상 유입 ${inflowPct >= 0 ? "+" : ""}${inflowPct}%)${planNote} · 확신도 ${state.confidence}% → 유지`,
    "thought"
  );
}

/**
 * Projects `PLAN_HORIZON` seconds forward under one candidate action —
 * switching phase right now, or holding — and returns a cost (lower is
 * better; the time-integral of queue length, i.e. total vehicle-seconds of
 * delay, the standard traffic-engineering way to score a queueing outcome).
 *
 * This is a deterministic *fluid* model — queues are tracked as continuous
 * numbers (arrival rate in, service rate out while green) rather than by
 * cloning the real state and re-running the discrete, randomized car-by-car
 * simulation. An earlier version did exactly that (clone + replay with an
 * independent RNG), and it was a real bug: over a short horizon at light
 * traffic, a handful of cars arriving in one candidate's random draw but not
 * the other's is pure noise, not signal — the AI ended up "planning" based on
 * which side happened to get lucky arrivals in that one sample, not which
 * decision actually helps. The fluid model feeds both candidates the exact
 * same continuous arrival rate and differs only in which side is served when,
 * which is the only thing this decision actually controls.
 */
function projectCost(state, arrivalRates, switchNow) {
  let phase = state.phase;
  let phaseElapsed = state.phaseElapsed;
  let yellow = state.yellow;
  let yellowElapsed = state.yellowElapsed;
  if (switchNow && !yellow) {
    yellow = true;
    yellowElapsed = 0;
  }

  const queue = {};
  for (const a of APPROACHES) queue[a] = approachQueueLength(state, a);
  const arrivalRate = (a) => (arrivalRates[a] ?? 0) / 60; // cars/sec
  const serviceRate = 1 / HEADWAY_THROUGH; // cars/sec cleared while green

  let cost = 0;
  for (let t = 0; t < PLAN_HORIZON; t += PLAN_STEP) {
    if (yellow) {
      yellowElapsed += PLAN_STEP;
      if (yellowElapsed >= YELLOW_TIME) {
        yellow = false;
        yellowElapsed = 0;
        phase = otherPhase(phase);
        phaseElapsed = 0;
      }
    } else {
      phaseElapsed += PLAN_STEP;
    }
    const greenSet = yellow ? [] : PHASES[phase];
    for (const a of APPROACHES) {
      queue[a] = Math.max(0, queue[a] + arrivalRate(a) * PLAN_STEP);
      if (greenSet.includes(a)) {
        queue[a] = Math.max(0, queue[a] - serviceRate * PLAN_STEP);
      }
      // Area under the queue-length curve ~ total vehicle-seconds of delay.
      cost += queue[a] * PLAN_STEP;
    }
  }
  return cost;
}

/**
 * Adaptive controller: gap-out / max-out actuated control, the same principle
 * real "smart" signal controllers use — extend green while it's still being
 * used, cut it short once the queue clears, and never starve the other side.
 * Layered on top: an EWMA arrival-rate forecast, a confidence estimate, a
 * hard fairness backstop so no single vehicle waits forever, and — for the
 * "is this actually worth switching for" judgment call — a mini-MPC that
 * simulates both options forward instead of guessing from a static threshold.
 */
export function adaptiveController(state, dt, arrivalRates) {
  const green = PHASES[state.phase];
  const red = PHASES[otherPhase(state.phase)];
  const greenQueue = green.reduce((s, a) => s + approachQueueLength(state, a), 0);
  const redQueue = red.reduce((s, a) => s + approachQueueLength(state, a), 0);
  state.confidence = computeConfidence(greenQueue, redQueue);

  // Fairness backstop: a single starved vehicle overrides everything else,
  // even the minimum-green lockout — extreme, but nobody should wait 55s+.
  const redOldestWait = Math.max(0, ...red.map((a) => oldestThroughWait(state, a)));
  if (redOldestWait >= STARVATION_LIMIT) {
    state.confidence = 99;
    return `⚖️ 공정성 개입: ${PHASE_LABEL[otherPhase(state.phase)]} 방향 차량이 ${Math.round(redOldestWait)}초째 대기 → 즉시 전환`;
  }

  if (state.phaseElapsed < MIN_GREEN) return null;

  if (state.phaseElapsed >= MAX_GREEN) {
    state.confidence = 65;
    return `${PHASE_LABEL[state.phase]} 방향 최대 녹색시간(${MAX_GREEN}s) 도달 → 전환`;
  }
  if (greenQueue === 0 && redQueue > 0) {
    state.confidence = 95;
    return `${PHASE_LABEL[state.phase]} 방향 대기 차량 없음 → 조기 전환`;
  }

  if (!arrivalRates || state.time - state.lastPlanAt < PLAN_INTERVAL) {
    logThought(state, greenQueue, redQueue);
    return null;
  }
  state.lastPlanAt = state.time;

  const costHold = projectCost(state, arrivalRates, false);
  const costSwitch = projectCost(state, arrivalRates, true);
  const redForecast = red.reduce((s, a) => s + forecastQueueLength(state, a, LOOKAHEAD), 0);

  if (costSwitch < costHold * PLAN_MARGIN) {
    const improvementPct = costHold > 0 ? Math.round((1 - costSwitch / costHold) * 100) : 0;
    state.confidence = Math.max(60, Math.min(97, 60 + improvementPct));
    return (
      `🔮 가상 실행(${PLAN_HORIZON}초 앞): 지금 전환하면 대기비용 ${costSwitch.toFixed(0)}, ` +
      `유지하면 ${costHold.toFixed(0)} (${improvementPct}% 개선 예상) · 반대편 ${redQueue}대 vs 현재 ${greenQueue}대 ` +
      `→ ${PHASE_LABEL[otherPhase(state.phase)]}로 전환`
    );
  }

  logThought(state, greenQueue, redQueue, { costHold, costSwitch, redForecast });
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

  // 1. Vehicle arrivals — also feeds the AI's own EWMA estimate of arrival
  // rate per approach (decay-then-impulse, converges to the true rate).
  for (const a of APPROACHES) {
    state.arrivalEwma[a] *= Math.exp(-dt / EWMA_TAU);
    const rate = arrivalRates[a] ?? 0;
    let expected = (rate / 60) * dt;
    while (expected > 0) {
      const chunk = Math.min(expected, 1);
      if (state.rng() < chunk) {
        const movement = pickMovement(state.rng);
        state.queues[a][LANE_OF[movement]].push({ id: state.nextId++, spawnTime: state.time, movement });
        state.arrivalEwma[a] += 1 / EWMA_TAU;
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
    const decision = controller(state, dt, arrivalRates);
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
