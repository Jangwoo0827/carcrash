import { mulberry32 } from "./random";
import { APPROACH, APPROACHES, MOVEMENT_TARGET, buildPath, crosswalkGeometry } from "./geometry";

export { APPROACHES };

export const PHASES = {
  NS: ["N", "S"],
  EW: ["E", "W"],
};

export const APPROACH_LABEL = { N: "북", S: "남", E: "동", W: "서" };
export const PHASE_LABEL = { NS: "남북", EW: "동서" };

const MIN_GREEN = 10; // seconds — fallback when arrival rates aren't available yet
const MAX_GREEN = 40; // seconds — fallback hard cap so one direction can't hog the light
// MIN_GREEN's floor stays at the original baseline (10s) — dropping it under
// light load caused a real regression during testing: gap-out fires the
// moment the queue hits zero, so a low minimum just makes the signal
// ping-pong every ~6-8s, and each switch burns YELLOW_TIME with almost
// nothing to show for it. Only the ceiling scales up under heavy demand.
const MIN_GREEN_FLOOR = 10; // seconds — baseline min-green, light demand
const MIN_GREEN_CEIL = 16; // seconds — longest min-green, under heavy green-side demand
const MAX_GREEN_FLOOR = 26; // seconds — shortest max-green, used when the red side is under heavy demand
const MAX_GREEN_CEIL = 60; // seconds — longest max-green, used when the red side is nearly empty
const YELLOW_TIME = 2.5; // seconds
const HEADWAY_THROUGH = 2.0; // seconds to clear one through car (~1800 veh/hr)
const HEADWAY_TURN = 2.6; // turning vehicles clear the stop line a bit slower
const LOG_LIMIT = 10;
const EWMA_TAU = 10; // seconds — smoothing window for the AI's own arrival-rate estimate
const LOOKAHEAD = 8; // seconds — how far ahead the AI projects queue growth
const STARVATION_LIMIT = 55; // seconds — nobody should wait longer than this, no matter what
const STARVATION_MIN_SERVE = 6; // seconds — a starvation override still needs this much real green first, or repeated overrides can starve BOTH sides at once (see adaptiveController)
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
const PLAN_MARGIN = 0.75; // switching must beat holding by at least ~25% to act (avoids noise-driven flapping)

// Protected left-turn ("lead-left"): permissive lefts yield to oncoming
// through/right traffic, and under heavy opposing flow that gap basically
// never opens — measured queue length in the rush scenario averaged ~24
// left-turners backed up vs ~5-6 through, which is a real bottleneck, not a
// tuning artifact. A lead-left window at the start of a phase stops both
// approaches' through/right traffic and lets both approaches' lefts go
// unimpeded, the same fix real signal engineers reach for. Fixed timing gets
// a naive flat-duration version (still "dumb", just not starved); the
// adaptive controller only spends time on it when the left queue actually
// justifies it.
const LEAD_LEFT_HEADWAY = 2.2; // seconds per protected-left departure — faster than HEADWAY_TURN since there's no gap-hunting
const LEAD_LEFT_MAX = 20; // seconds — cap so a huge left backlog can't starve the through movement entirely
const ADAPTIVE_LEAD_LEFT_THRESHOLD = 2; // vehicles — below this, permissive lefts clear fine on their own, not worth the overhead
const FIXED_LEAD_LEFT_DURATION = 8; // seconds — flat window, no queue awareness (matches "fixed timing" philosophy)

const CROSS_DURATION = { through: 1.8, left: 2.6, right: 2.2, uturn: 3.0 };
// Movement mix for newly-arriving traffic on any approach.
const MOVEMENT_WEIGHTS = [
  ["through", 0.65],
  ["right", 0.2],
  ["left", 0.12],
  ["uturn", 0.03],
];
const LANE_OF = { through: "through", left: "left", right: "right", uturn: "left" };

export const DEFAULT_PED_RATE = 7; // pedestrians/min per crosswalk (user-adjustable via slider)
const PED_DURATION = 3.2; // seconds to cross
const PED_RELEASE_INTERVAL = 0.25; // seconds between waiting pedestrians stepping off the curb (a crowd crosses together)
const PED_COST_CAP = 20; // waiting pedestrians beyond this stop adding cost (a crowd crosses together, so it does not scale linearly)
const PED_CROWD = 10; // waiting pedestrians on a leg that count as a crowd worth shortening lead-left for
const PED_CROWD_LEAD_LEFT = 6; // seconds — the adaptive lead-left cap while a crowd is waiting
const PED_WEIGHT = 1.5; // one waiting pedestrian counts like this many waiting cars in the AI's cost
const PED_MIN_GREEN = 9; // seconds — a phase serving waiting pedestrians keeps green at least this long
const PED_MAX_NEEDED = 26; // seconds — cap on green held just to drain a big crowd
const PED_STARVATION_LIMIT = 40; // seconds — pedestrians shouldn't wait longer than this either

export const FIXED_GREEN = 15; // baseline fixed-time cycle half-length

function otherPhase(phase) {
  return phase === "NS" ? "EW" : "NS";
}

function oppositeApproach(a) {
  return { N: "S", S: "N", E: "W", W: "E" }[a];
}

const SAT_FLOW_PER_MIN = 60 / HEADWAY_THROUGH; // one lane's max clearable rate, veh/min

/**
 * Fixed MIN_GREEN/MAX_GREEN bounds waste time either way: a heavy-demand
 * green cut off at a low fixed minimum barely gets going before it's
 * eligible to switch again, while a light-demand green forced to hold the
 * same minimum sits idle-green for no reason. Scaling both bounds by how
 * loaded the relevant side actually is (relative to one lane's saturation
 * flow) lets the signal react fast when traffic is light and hold longer
 * only when the demand actually justifies it.
 */
function dynamicMinGreen(arrivalRates, greenApproaches) {
  if (!arrivalRates) return MIN_GREEN;
  const demand = greenApproaches.reduce((s, a) => s + (arrivalRates[a] ?? 0), 0);
  const load = Math.min(1, demand / SAT_FLOW_PER_MIN);
  return MIN_GREEN_FLOOR + (MIN_GREEN_CEIL - MIN_GREEN_FLOOR) * load;
}

function dynamicMaxGreen(arrivalRates, redApproaches) {
  if (!arrivalRates) return MAX_GREEN;
  const redDemand = redApproaches.reduce((s, a) => s + (arrivalRates[a] ?? 0), 0);
  const redLoad = Math.min(1, redDemand / SAT_FLOW_PER_MIN);
  // Heavier red-side demand => shorter cap (serve it sooner); quiet red side
  // => longer cap allowed (no point cutting a productive green short).
  return MAX_GREEN_CEIL - (MAX_GREEN_CEIL - MAX_GREEN_FLOOR) * redLoad;
}

function groupLeftQueue(state, group) {
  return group.reduce((s, a) => s + state.queues[a].left.length, 0);
}

/** Legs whose crosswalk is walkable while `phase` is green (the perpendicular street's legs). */
function walkLegs(phase) {
  return phase === "NS" ? ["E", "W"] : ["N", "S"];
}

function pedsWaitingOn(state, legs) {
  return legs.reduce((s, l) => s + state.pedWaiting[l].length, 0);
}

function pedsCrossingOn(state, legs) {
  return legs.reduce((s, l) => s + state.pedestrians[l].length, 0);
}

/** Green a phase needs to walk the crowd on `legs` across: crossing time plus stepping them off the curb. */
function pedGreenNeeded(state, legs) {
  const waitingMax = Math.max(0, ...legs.map((l) => state.pedWaiting[l].length));
  if (waitingMax + pedsCrossingOn(state, legs) === 0) return 0;
  return Math.min(PED_MAX_NEEDED, Math.max(PED_MIN_GREEN, PED_DURATION + 2 + waitingMax * PED_RELEASE_INTERVAL));
}

function oldestPedWait(state, legs) {
  let oldest = 0;
  for (const l of legs) {
    const q = state.pedWaiting[l];
    if (q.length > 0) oldest = Math.max(oldest, state.time - q[0].spawnTime);
  }
  return oldest;
}

/** Dumb fixed-timing policy: always spend a flat window on lefts if any are waiting. */
export function fixedLeadLeftPolicy(state) {
  return groupLeftQueue(state, PHASES[state.phase]) > 0 ? FIXED_LEAD_LEFT_DURATION : 0;
}

/** Smart policy: only spend time on it once the backlog actually justifies the overhead. */
export function adaptiveLeadLeftPolicy(state) {
  const q = groupLeftQueue(state, PHASES[state.phase]);
  if (q < ADAPTIVE_LEAD_LEFT_THRESHOLD) return 0;
  const duration = Math.min(LEAD_LEFT_MAX, q * LEAD_LEFT_HEADWAY);
  // Pedestrians can't walk during lead-left, so a crowd at the curb shortens it.
  const crowd = Math.max(0, ...walkLegs(state.phase).map((l) => state.pedWaiting[l].length));
  return crowd >= PED_CROWD ? Math.min(duration, PED_CROWD_LEAD_LEFT) : duration;
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
    pedWaiting: { N: [], S: [], E: [], W: [] },
    pedClosing: false,
    pendingReason: null,
    pedTimer: { N: PED_RELEASE_INTERVAL, S: PED_RELEASE_INTERVAL, E: PED_RELEASE_INTERVAL, W: PED_RELEASE_INTERVAL },
    phase: "NS",
    phaseElapsed: 0,
    yellow: false,
    yellowElapsed: 0,
    leadLeft: false,
    leadLeftElapsed: 0,
    leadLeftPlanned: 0,
    lastSwitchReason: null,
    arrivalEwma: { N: 0, S: 0, E: 0, W: 0 },
    confidence: 50,
    lastThoughtAt: -THOUGHT_INTERVAL,
    lastPlanAt: -PLAN_INTERVAL,
    queueSnapshot: { N: 0, S: 0, E: 0, W: 0 },
    stats: {
      departed: { N: 0, S: 0, E: 0, W: 0 },
      totalWait: { N: 0, S: 0, E: 0, W: 0 },
      pedServed: { N: 0, S: 0, E: 0, W: 0 },
      pedTotalWait: { N: 0, S: 0, E: 0, W: 0 },
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

function logThought(state, greenQueue, redQueue, plan, pedWaitCount = 0) {
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
  const pedNote = pedWaitCount > 0 ? ` · 🚶대기 ${pedWaitCount}명` : "";

  for (const a of APPROACHES) state.queueSnapshot[a] = approachQueueLength(state, a);

  pushLog(
    state,
    `[${PHASE_LABEL[state.phase]} 진행 ${Math.floor(state.phaseElapsed)}s] 현재측 ${greenTrend} · 반대측 ${redTrend} (${LOOKAHEAD}초 후 예상 유입 ${inflowPct >= 0 ? "+" : ""}${inflowPct}%)${planNote}${pedNote} · 확신도 ${state.confidence}% → 유지`,
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
function projectCost(state, arrivalRates, pedRate, switchNow) {
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
  const pedQueue = {};
  for (const a of APPROACHES) pedQueue[a] = state.pedWaiting[a].length;
  const pedArrival = (pedRate ?? 0) / 60; // pedestrians/sec per crosswalk
  const pedService = 1 / PED_RELEASE_INTERVAL;
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

      // Pedestrians on this leg cross while the perpendicular phase is green.
      const walkable = !yellow && walkLegs(phase).includes(a);
      pedQueue[a] = Math.max(0, pedQueue[a] + pedArrival * PLAN_STEP);
      if (walkable) pedQueue[a] = Math.max(0, pedQueue[a] - pedService * PLAN_STEP);
      cost += PED_WEIGHT * Math.min(pedQueue[a], PED_COST_CAP) * PLAN_STEP;
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
export function adaptiveController(state, dt, arrivalRates, pedRate) {
  const walkNow = walkLegs(state.phase);

  // Pedestrian clearance: once a switch is decided, stop sending new
  // pedestrians and wait (a few seconds) for the ones already crossing to
  // finish, so cross traffic never gets green on top of them.
  if (state.pedClosing) {
    if (pedsCrossingOn(state, walkNow) > 0) return null;
    const reason = state.pendingReason;
    state.pedClosing = false;
    state.pendingReason = null;
    return reason ?? true;
  }

  const decision = decideSwitch(state, dt, arrivalRates, pedRate);
  if (decision && pedsCrossingOn(state, walkNow) > 0) {
    state.pedClosing = true;
    state.pendingReason = typeof decision === "string" ? decision : null;
    return null;
  }
  return decision;
}

function decideSwitch(state, dt, arrivalRates, pedRate) {
  const green = PHASES[state.phase];
  const red = PHASES[otherPhase(state.phase)];
  const greenQueue = green.reduce((s, a) => s + approachQueueLength(state, a), 0);
  const redQueue = red.reduce((s, a) => s + approachQueueLength(state, a), 0);
  state.confidence = computeConfidence(greenQueue, redQueue);

  // Fairness backstop: a single starved vehicle overrides everything else,
  // even the minimum-green lockout — extreme, but nobody should wait 55s+.
  // It still requires STARVATION_MIN_SERVE seconds of actual green first,
  // though: without that floor, once BOTH sides are simultaneously near the
  // limit (which heavy congestion can absolutely cause), the override fires
  // again the instant the *next* phase starts, before it has served a single
  // car — yellow and lead-left in a loop with ~0 real throughput, which only
  // pushes both queues (and thus both oldest-waits) further up. This was a
  // real bug found by running the sim for 2+ hours: the queue spiraled to
  // 1000+ vehicles from exactly this switch-storm once congestion crossed a
  // critical mass. A short serve floor breaks the loop by guaranteeing every
  // switch actually buys some real service before it can be pre-empted again.
  const redOldestWait = Math.max(0, ...red.map((a) => oldestThroughWait(state, a)));
  if (redOldestWait >= STARVATION_LIMIT && state.phaseElapsed >= STARVATION_MIN_SERVE) {
    state.confidence = 99;
    return `⚖️ 공정성 개입: ${PHASE_LABEL[otherPhase(state.phase)]} 방향 차량이 ${Math.round(redOldestWait)}초째 대기 → 즉시 전환`;
  }

  // Pedestrians get the same guarantee. Pedestrians waiting right now are on
  // the legs that only become walkable once this phase ends.
  const walkNow = walkLegs(state.phase);
  const walkNext = walkLegs(otherPhase(state.phase));
  const pedOldest = oldestPedWait(state, walkNext);
  const pedNeeded = pedGreenNeeded(state, walkNow);
  if (pedOldest >= PED_STARVATION_LIMIT && state.phaseElapsed >= Math.max(STARVATION_MIN_SERVE, pedNeeded)) {
    state.confidence = 92;
    return `🚶 보행자 보호: 횡단보도 보행자가 ${Math.round(pedOldest)}초째 대기 → 보행 신호로 전환`;
  }

  let minGreen = dynamicMinGreen(arrivalRates, green);
  const maxGreen = dynamicMaxGreen(arrivalRates, red);
  // Pedestrians being served this phase need enough green to actually cross.
  minGreen = Math.max(minGreen, pedNeeded);

  if (state.phaseElapsed < minGreen) return null;

  if (state.phaseElapsed >= maxGreen) {
    state.confidence = 65;
    return `${PHASE_LABEL[state.phase]} 방향 최대 녹색시간(${Math.round(maxGreen)}s) 도달 → 전환`;
  }
  if (greenQueue === 0 && redQueue > 0) {
    state.confidence = 95;
    return `${PHASE_LABEL[state.phase]} 방향 대기 차량 없음 → 조기 전환`;
  }

  if (!arrivalRates || state.time - state.lastPlanAt < PLAN_INTERVAL) {
    logThought(state, greenQueue, redQueue, undefined, pedsWaitingOn(state, walkNext));
    return null;
  }
  state.lastPlanAt = state.time;

  const costHold = projectCost(state, arrivalRates, pedRate, false);
  const costSwitch = projectCost(state, arrivalRates, pedRate, true);
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

  logThought(state, greenQueue, redQueue, { costHold, costSwitch, redForecast }, pedsWaitingOn(state, walkNext));
  return null;
}

export function crosswalkWalkable(state, leg) {
  if (state.yellow) return false;
  // Lead-left is the one window where turning cars own the box; walking
  // pedestrians there would just block the lefts it exists to clear.
  if (state.leadLeft) return false;
  return leg === "N" || leg === "S" ? state.phase === "EW" : state.phase === "NS";
}

export function isCrosswalkOccupied(state, leg) {
  return state.pedestrians[leg].some((p) => p.progress > 0.02 && p.progress < 0.98);
}

const PED_CONFLICT_RADIUS = 14; // px — how close a pedestrian must be to a vehicle's exit lane to block it

/**
 * Cars leaving onto `leg` only cross the crosswalk in their own outbound lane,
 * so a pedestrian on the far half of the crosswalk doesn't block them.
 */
function pedInExitLane(state, leg) {
  const geo = crosswalkGeometry(leg);
  const off = APPROACH[leg].outboundOffset;
  const px = geo.center.x + off.x;
  const py = geo.center.y + off.y;
  return state.pedestrians[leg].some((p) => {
    if (p.progress <= 0.02 || p.progress >= 0.98) return false;
    const x = geo.from.x + (geo.to.x - geo.from.x) * p.progress;
    const y = geo.from.y + (geo.to.y - geo.from.y) * p.progress;
    return Math.hypot(x - px, y - py) < PED_CONFLICT_RADIUS;
  });
}

/** A left-turner (or U-turner) waits while a pedestrian is in the crosswalk it would cross. */
function leftBlockedByPed(state, approach) {
  const front = state.queues[approach].left[0];
  return !!front && pedInExitLane(state, MOVEMENT_TARGET[approach][front.movement]);
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

export function stepSimulation(state, dt, { arrivalRates, controller, leadLeftPolicy, pedRate = DEFAULT_PED_RATE }) {
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

  // 2. Signal phase / yellow / lead-left transition
  if (state.yellow) {
    state.yellowElapsed += dt;
    if (state.yellowElapsed >= YELLOW_TIME) {
      state.yellow = false;
      state.yellowElapsed = 0;
      state.phase = otherPhase(state.phase);
      state.phaseElapsed = 0;
      state.pedClosing = false;
      state.pendingReason = null;
      const duration = leadLeftPolicy ? leadLeftPolicy(state, arrivalRates) : 0;
      state.leadLeft = duration > 0;
      state.leadLeftElapsed = 0;
      state.leadLeftPlanned = duration;
    }
  } else if (state.leadLeft) {
    state.leadLeftElapsed += dt;
    if (state.leadLeftElapsed >= state.leadLeftPlanned || groupLeftQueue(state, PHASES[state.phase]) === 0) {
      state.leadLeft = false;
      state.phaseElapsed = 0;
    }
  } else {
    state.phaseElapsed += dt;
    const decision = controller(state, dt, arrivalRates, pedRate);
    if (decision) switchPhase(state, typeof decision === "string" ? decision : null);
  }

  // 3. Through-lane departures (only while this approach's phase is green,
  // and paused during a lead-left window since the whole point of that
  // window is to hold both approaches' through traffic so their lefts can
  // cross unimpeded).
  for (const a of APPROACHES) {
    const isGreen = !state.yellow && !state.leadLeft && PHASES[state.phase].includes(a);
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

  // 4. Left-lane departures. During a lead-left window both approaches'
  // opposing through/right traffic is held (see step 3), so lefts run
  // unimpeded at their own (faster) headway. Outside that window, lefts fall
  // back to permissive behavior: gated by the same green, but only when the
  // opposing approach isn't currently sending a car through the box (a rough
  // stand-in for "yield to oncoming traffic, take the gap when it appears").
  for (const a of APPROACHES) {
    const inGroup = !state.yellow && PHASES[state.phase].includes(a);
    if (!inGroup) {
      state.serviceTimer[a].left = 0;
      continue;
    }
    if (state.leadLeft) {
      state.serviceTimer[a].left = Math.min(state.serviceTimer[a].left + dt, LEAD_LEFT_HEADWAY);
      while (
        state.serviceTimer[a].left >= LEAD_LEFT_HEADWAY &&
        state.queues[a].left.length > 0 &&
        !leftBlockedByPed(state, a)
      ) {
        state.serviceTimer[a].left -= LEAD_LEFT_HEADWAY;
        departVehicle(state, a, "left");
      }
      if (state.queues[a].left.length === 0) state.serviceTimer[a].left = 0;
      continue;
    }
    const opp = oppositeApproach(a);
    const oppOccupied = state.crossing.some(
      (v) => v.approach === opp && (v.movement === "through" || v.movement === "right")
    );
    if (oppOccupied) {
      state.serviceTimer[a].left = 0;
      continue;
    }
    state.serviceTimer[a].left = Math.min(state.serviceTimer[a].left + dt, HEADWAY_TURN);
    while (
      state.serviceTimer[a].left >= HEADWAY_TURN &&
      state.queues[a].left.length > 0 &&
      !leftBlockedByPed(state, a)
    ) {
      state.serviceTimer[a].left -= HEADWAY_TURN;
      departVehicle(state, a, "left");
    }
    if (state.queues[a].left.length === 0) state.serviceTimer[a].left = 0;
  }

  // 5. Right turns flow independently of the signal, yielding only to a
  // pedestrian currently in the crosswalk they'd cross.
  for (const a of APPROACHES) {
    const exitLeg = MOVEMENT_TARGET[a].right;
    if (pedInExitLane(state, exitLeg)) continue;
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

  // 7. Pedestrians: arrive at the curb whether or not they can cross, wait
  // there, and step off (one every PED_RELEASE_INTERVAL) once their crosswalk
  // is walkable; crossing pedestrians advance regardless.
  for (const leg of APPROACHES) {
    let expected = (pedRate / 60) * dt;
    while (expected > 0) {
      const chunk = Math.min(expected, 1);
      if (state.rng() < chunk) state.pedWaiting[leg].push({ id: state.nextId++, spawnTime: state.time });
      expected -= 1;
    }

    const waiting = state.pedWaiting[leg];
    if (crosswalkWalkable(state, leg) && !state.pedClosing) {
      state.pedTimer[leg] = Math.min(state.pedTimer[leg] + dt, PED_RELEASE_INTERVAL);
      while (state.pedTimer[leg] >= PED_RELEASE_INTERVAL && waiting.length > 0) {
        state.pedTimer[leg] -= PED_RELEASE_INTERVAL;
        const w = waiting.shift();
        state.pedestrians[leg].push({ id: w.id, progress: 0 });
        state.stats.pedServed[leg]++;
        state.stats.pedTotalWait[leg] += state.time - w.spawnTime;
      }
    } else {
      state.pedTimer[leg] = PED_RELEASE_INTERVAL;
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

export function totalPedServed(state) {
  return APPROACHES.reduce((s, a) => s + state.stats.pedServed[a], 0);
}

export function averagePedWait(state) {
  const served = totalPedServed(state);
  if (served === 0) return 0;
  return APPROACHES.reduce((s, a) => s + state.stats.pedTotalWait[a], 0) / served;
}

export function totalPedWaiting(state) {
  return APPROACHES.reduce((s, a) => s + state.pedWaiting[a].length, 0);
}
