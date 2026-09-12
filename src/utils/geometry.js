// Coordinate system for the 2.5D intersection scene. Units are CSS px in an
// untilted top-down plane; the scene component applies a perspective/rotateX
// transform on top of this to get the angled "2.5D" look.
export const SCENE_SIZE = 320;
export const CENTER = { x: 160, y: 160 };
export const ARM = 160; // distance from center to the edge of the scene
export const LANE_OFFSET = 16; // half-lane offset from the road centerline
export const STOP_LINE_DIST = 46; // distance from center where queued vehicles wait
export const ROAD_HALF = 34; // half-width of the full two-way road

// Each compass approach: `dir` is the unit travel direction for vehicles
// ENTERING from that approach (pointing toward the center). `inboundOffset`
// places the entering lane on the correct side of the road centerline (right-
// hand traffic); `outboundOffset` is the parallel lane used by vehicles
// leaving via that same arm — together they keep opposite-direction traffic
// on consistent sides across the whole road, not just at one arm.
export const APPROACHES = ["N", "S", "E", "W"];

export const APPROACH = {
  N: { dir: { x: 0, y: 1 }, inboundOffset: { x: -LANE_OFFSET, y: 0 }, outboundOffset: { x: LANE_OFFSET, y: 0 }, edge: { x: CENTER.x, y: 0 } },
  S: { dir: { x: 0, y: -1 }, inboundOffset: { x: LANE_OFFSET, y: 0 }, outboundOffset: { x: -LANE_OFFSET, y: 0 }, edge: { x: CENTER.x, y: SCENE_SIZE } },
  E: { dir: { x: -1, y: 0 }, inboundOffset: { x: 0, y: LANE_OFFSET }, outboundOffset: { x: 0, y: -LANE_OFFSET }, edge: { x: SCENE_SIZE, y: CENTER.y } },
  W: { dir: { x: 1, y: 0 }, inboundOffset: { x: 0, y: -LANE_OFFSET }, outboundOffset: { x: 0, y: LANE_OFFSET }, edge: { x: 0, y: CENTER.y } },
};

// Where each approach's movement exits. Derived from "rotate travel bearing by
// +/-90deg" for right-hand traffic (see trafficSim.js for the full argument).
export const MOVEMENT_TARGET = {
  N: { through: "S", left: "E", right: "W", uturn: "N" },
  S: { through: "N", left: "W", right: "E", uturn: "S" },
  E: { through: "W", left: "S", right: "N", uturn: "E" },
  W: { through: "E", left: "N", right: "S", uturn: "W" },
};

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scale(v, s) {
  return { x: v.x * s, y: v.y * s };
}

// Three visually distinct sub-lanes within the inbound half of the road,
// expressed as a scale on the approach's single inboundOffset vector (same
// axis, just nearer to or farther from the centerline) — cheap way to show
// left/through/right as separate lanes without a full multi-lane geometry.
const LANE_FACTOR = { left: 0.4, through: 1, right: 1.6 };

export function laneCategory(movement) {
  return movement === "uturn" ? "left" : movement;
}

export function inboundLaneOffset(approach, lane) {
  return scale(APPROACH[approach].inboundOffset, LANE_FACTOR[lane] ?? 1);
}

export function spawnPoint(approach, lane = "through") {
  const a = APPROACH[approach];
  return add(add(CENTER, scale(a.dir, -ARM)), inboundLaneOffset(approach, lane));
}

export function stopPoint(approach, lane = "through") {
  const a = APPROACH[approach];
  return add(add(CENTER, scale(a.dir, -STOP_LINE_DIST)), inboundLaneOffset(approach, lane));
}

export function exitEdgePoint(approach) {
  const a = APPROACH[approach];
  return add(add(CENTER, scale(a.dir, -ARM)), a.outboundOffset);
}

function centerLanePoint(approach, offsetKind) {
  const a = APPROACH[approach];
  return add(CENTER, a[offsetKind]);
}

/** Quadratic bezier sample: point + tangent angle (radians) at t in [0,1]. */
function quadBezier(p0, p1, p2, t) {
  const mt = 1 - t;
  const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
  const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
  const dx = 2 * mt * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
  const dy = 2 * mt * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
  return { x, y, angle: Math.atan2(dy, dx) };
}

function lerpPoint(p0, p1, t) {
  return {
    x: p0.x + (p1.x - p0.x) * t,
    y: p0.y + (p1.y - p0.y) * t,
    angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
  };
}

/**
 * Builds a sampleable path for a vehicle entering from `approach` performing
 * `movement`. The path runs from just behind the stop line, through the
 * intersection box, out to the exit edge of the target arm.
 */
export function buildPath(approach, movement) {
  const from = APPROACH[approach];
  const lane = laneCategory(movement);
  const start = stopPoint(approach, lane);
  const enterCenter = add(CENTER, inboundLaneOffset(approach, lane));

  if (movement === "uturn") {
    // Tight loop: curve into the median and back out the same arm's outbound lane.
    const exitStart = centerLanePoint(approach, "outboundOffset");
    const end = exitEdgePoint(approach);
    const loopOut = add(enterCenter, scale(from.dir, 14));
    const control1 = add(loopOut, scale({ x: -from.dir.y, y: from.dir.x }, 22));
    const control2 = add(exitStart, scale({ x: -from.dir.y, y: from.dir.x }, 22));
    return {
      kind: "uturn",
      sample(t) {
        if (t < 0.5) return quadBezier(start, loopOut, control1, t / 0.5);
        if (t < 0.85) return quadBezier(control1, control2, exitStart, (t - 0.5) / 0.35);
        return lerpPoint(exitStart, end, (t - 0.85) / 0.15);
      },
    };
  }

  const targetApproach = MOVEMENT_TARGET[approach][movement];
  const end = exitEdgePoint(targetApproach);
  const exitLane = centerLanePoint(targetApproach, "outboundOffset");

  if (movement === "through") {
    return {
      kind: "through",
      sample(t) {
        if (t < 0.2) return lerpPoint(start, enterCenter, t / 0.2);
        if (t < 0.8) return lerpPoint(enterCenter, exitLane, (t - 0.2) / 0.6);
        return lerpPoint(exitLane, end, (t - 0.8) / 0.2);
      },
    };
  }

  // Left/right turns always cross from a vertical-axis approach (N/S) to a
  // horizontal-axis one (E/W) or vice versa. The "L-corner" — where the
  // entry's tangent line meets the exit's tangent line — is the single
  // quadratic-bezier control point that makes a smooth quarter-circle-ish arc.
  const enterIsVertical = approach === "N" || approach === "S";
  const turnControl = enterIsVertical
    ? { x: enterCenter.x, y: exitLane.y }
    : { x: exitLane.x, y: enterCenter.y };

  return {
    kind: movement,
    sample(t) {
      if (t < 0.15) return lerpPoint(start, enterCenter, t / 0.15);
      if (t < 0.75) return quadBezier(enterCenter, turnControl, exitLane, (t - 0.15) / 0.6);
      return lerpPoint(exitLane, end, (t - 0.75) / 0.25);
    },
  };
}

/** Crosswalk geometry: a short strip just outside the intersection box on each arm. */
export function crosswalkGeometry(approach) {
  const a = APPROACH[approach];
  const mid = add(CENTER, scale(a.dir, -(ROAD_HALF + 8)));
  const across = { x: -a.dir.y, y: a.dir.x };
  const half = ROAD_HALF;
  return {
    from: add(mid, scale(across, -half)),
    to: add(mid, scale(across, half)),
    center: mid,
    axis: a.dir, // road direction this crosswalk cuts across
  };
}
