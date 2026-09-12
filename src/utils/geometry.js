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

/**
 * Cubic bezier sample: point + tangent angle (radians) at t in [0,1].
 * Unlike a single-control-point quadratic, a cubic's end tangents are set
 * directly by (p1-p0) and (p3-p2) — so building it from real travel
 * directions (see buildPath) guarantees the curve enters and leaves facing
 * the right way, regardless of where the lane offsets happen to place the
 * endpoints relative to each other.
 */
function cubicBezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
  const y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
  const dx = 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
  const dy = 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
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
    // A loop that leaves heading `dir` and returns heading `-dir`. Control
    // points are placed by pushing straight out from each endpoint along its
    // own real travel direction, so the tangent at both ends is exact by
    // construction — no dependence on where the lane offsets land the points.
    const exitStart = centerLanePoint(approach, "outboundOffset");
    const end = exitEdgePoint(approach);
    const handle = 24;
    const c1 = add(enterCenter, scale(from.dir, handle));
    const c2 = add(exitStart, scale(from.dir, handle)); // exit direction is -from.dir
    return {
      kind: "uturn",
      sample(t) {
        if (t < 0.1) return lerpPoint(start, enterCenter, t / 0.1);
        if (t < 0.75) return cubicBezier(enterCenter, c1, c2, exitStart, (t - 0.1) / 0.65);
        return lerpPoint(exitStart, end, (t - 0.75) / 0.25);
      },
    };
  }

  const targetApproach = MOVEMENT_TARGET[approach][movement];

  if (movement === "through") {
    // Opposite approaches share the same lane offset by construction (see
    // the APPROACH table above), so `enterCenter` and the equivalent point on
    // the exit lane are literally the same coordinate — a "start -> center ->
    // end" path used to lerp into that shared point and sit there (zero
    // velocity) for the whole middle 60% of the crossing. It's just one
    // straight line the entire way; sample it as one.
    return {
      kind: "through",
      sample(t) {
        return lerpPoint(start, exitEdgePoint(targetApproach), t);
      },
    };
  }

  // Left/right turns as a true circular arc. A cubic bezier tied to the raw
  // entry/exit coordinates could overshoot and loop back on itself whenever a
  // wider lane offset (e.g. the outboard right-turn lane) shifted the points
  // out of the "nice" arrangement — a circle can't do that: pick a center R
  // to the turning side of the car, and the 90-degree arc between the two
  // perpendicular tangent lines is smooth by definition, no matter where the
  // lane offsets place the endpoints.
  // Rotate the entry radius vector by exactly +/-90deg (never independently
  // re-derived from the exit direction) so the exit tangent is *guaranteed*
  // perpendicular to the entry tangent — i.e. always exactly matches exitDir,
  // since any turn is by definition a 90-degree change of direction.
  const turnSide = movement === "right" ? rightPerp(from.dir) : leftPerp(from.dir);
  const sweep = movement === "right" ? Math.PI / 2 : -Math.PI / 2;
  const radius = 22;
  const arcCenter = add(enterCenter, scale(turnSide, radius));
  const theta1 = Math.atan2(enterCenter.y - arcCenter.y, enterCenter.x - arcCenter.x);
  const theta2 = theta1 + sweep;
  const arcExit = { x: arcCenter.x + radius * Math.cos(theta2), y: arcCenter.y + radius * Math.sin(theta2) };
  const exitTangentAngle = theta2 + (sweep >= 0 ? Math.PI / 2 : -Math.PI / 2);
  // Continue straight out from arcExit along its own exact tangent, rather
  // than aiming at the independently-computed edge point — the edge point
  // sits on the lane's true centerline while arcExit is offset from it by
  // whatever the lane spread happens to be, so aiming at it would reintroduce
  // a (smaller, but still visible) kink right where the arc ends.
  const exitDirExact = { x: Math.cos(exitTangentAngle), y: Math.sin(exitTangentAngle) };
  const farExit = add(arcExit, scale(exitDirExact, ARM * 2));

  return {
    kind: movement,
    sample(t) {
      if (t < 0.1) return lerpPoint(start, enterCenter, t / 0.1);
      if (t < 0.8) {
        const u = (t - 0.1) / 0.7;
        const theta = theta1 + sweep * u;
        return {
          x: arcCenter.x + radius * Math.cos(theta),
          y: arcCenter.y + radius * Math.sin(theta),
          angle: theta + (sweep >= 0 ? Math.PI / 2 : -Math.PI / 2),
        };
      }
      return lerpPoint(arcExit, farExit, (t - 0.8) / 0.2);
    },
  };
}

function rightPerp(d) {
  return { x: -d.y, y: d.x };
}
function leftPerp(d) {
  return { x: d.y, y: -d.x };
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
