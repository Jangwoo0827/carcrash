// A genuinely lightweight 2D renderer: plain SVG shapes (rect/circle/polygon),
// no Three.js, no GLTF, no WebGL context at all. Scene3D's "2D" camera mode
// still paid the full cost of loading/cloning GLB meshes and running a WebGL
// render loop per panel — fine at normal speed, but two such canvases start
// to choke the frame budget once the simulation (and therefore the number of
// visible vehicles) is running at extreme multipliers. This component uses
// the exact same geometry.js math, just drawn as cheap 2D primitives instead.
import {
  APPROACH,
  APPROACHES,
  CENTER,
  ROAD_HALF,
  SCENE_SIZE,
  crosswalkGeometry,
  laneCategory,
  stopPoint,
} from "../utils/geometry";
import { crosswalkWalkable, lightStateFor } from "../utils/trafficSim";

const LANES = ["left", "through", "right"];
const QUEUE_SPACING = 15;
const MAX_QUEUE_SHOWN = 8;
const CAR_COLOR = { through: "#3182f6", left: "#a855f7", uturn: "#a855f7", right: "#f59e0b" };
const LIGHT_COLOR = { red: "#f04452", yellow: "#f5a623", green: "#2ecc71" };

function deg(rad) {
  return (rad * 180) / Math.PI;
}

function Car({ x, y, angleDeg, movement }) {
  return (
    <g transform={`translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${angleDeg.toFixed(1)})`}>
      <rect x={-8} y={-4.5} width={16} height={9} rx={2.5} fill={CAR_COLOR[movement] ?? CAR_COLOR.through} />
      <polygon points="4,-3 9,0 4,3" fill="rgba(255,255,255,0.85)" />
    </g>
  );
}

function QueuedVehicles({ state }) {
  const items = [];
  for (const approach of APPROACHES) {
    const a = APPROACH[approach];
    const angleDeg = deg(Math.atan2(a.dir.y, a.dir.x));
    for (const lane of LANES) {
      const cat = laneCategory(lane);
      const base = stopPoint(approach, cat);
      const queue = state.queues[approach][lane];
      const shown = Math.min(queue.length, MAX_QUEUE_SHOWN);
      for (let i = 0; i < shown; i++) {
        const back = i * QUEUE_SPACING;
        items.push(
          <Car
            key={`${approach}-${lane}-${i}`}
            x={base.x - a.dir.x * back}
            y={base.y - a.dir.y * back}
            angleDeg={angleDeg}
            movement={lane}
          />
        );
      }
    }
  }
  return items;
}

function CrossingVehicles({ crossing }) {
  return crossing.map((v) => {
    const p = v.path.sample(Math.min(1, v.progress));
    return <Car key={v.id} x={p.x} y={p.y} angleDeg={deg(p.angle)} movement={v.movement} />;
  });
}

function Pedestrians({ state }) {
  const dots = [];
  for (const leg of APPROACHES) {
    const geo = crosswalkGeometry(leg);
    for (const p of state.pedestrians[leg]) {
      const x = geo.from.x + (geo.to.x - geo.from.x) * p.progress;
      const y = geo.from.y + (geo.to.y - geo.from.y) * p.progress;
      dots.push(<circle key={p.id} cx={x} cy={y} r={3.4} fill="#ffd166" />);
    }
  }
  return dots;
}

function TrafficLights({ state }) {
  return APPROACHES.map((approach) => {
    const light = lightStateFor(state, approach);
    const a = APPROACH[approach];
    const perp = { x: -a.dir.y, y: a.dir.x };
    const x = CENTER.x - a.dir.x * (ROAD_HALF + 14) + perp.x * 22;
    const y = CENTER.y - a.dir.y * (ROAD_HALF + 14) + perp.y * 22;
    return (
      <g key={approach}>
        <rect x={x - 4} y={y - 4} width={8} height={8} rx={2} fill="#1c1e22" />
        <circle cx={x} cy={y} r={2.6} fill={LIGHT_COLOR[light]} />
      </g>
    );
  });
}

function Crosswalks({ state }) {
  return APPROACHES.map((approach) => {
    const geo = crosswalkGeometry(approach);
    const vertical = approach === "N" || approach === "S";
    const length = ROAD_HALF * 2 - 6;
    const width = 14;
    const walkable = crosswalkWalkable(state, approach);
    const rectProps = vertical
      ? { x: geo.center.x - length / 2, y: geo.center.y - width / 2, width: length, height: width }
      : { x: geo.center.x - width / 2, y: geo.center.y - length / 2, width, height: length };
    return <rect key={approach} {...rectProps} fill={walkable ? "#e8ecf1" : "#5a5f6a"} opacity={walkable ? 0.9 : 0.5} />;
  });
}

export default function Scene2D({ state }) {
  const roadWidth = ROAD_HALF * 2;
  return (
    <svg viewBox={`0 0 ${SCENE_SIZE} ${SCENE_SIZE}`} className="scene-2d">
      <rect x={0} y={0} width={SCENE_SIZE} height={SCENE_SIZE} fill="#0c0d10" />
      <rect x={CENTER.x - roadWidth / 2} y={0} width={roadWidth} height={SCENE_SIZE} fill="#33363d" />
      <rect x={0} y={CENTER.y - roadWidth / 2} width={SCENE_SIZE} height={roadWidth} fill="#33363d" />
      <rect
        x={CENTER.x - roadWidth / 2}
        y={CENTER.y - roadWidth / 2}
        width={roadWidth}
        height={roadWidth}
        fill="#3a3d45"
      />
      <line x1={CENTER.x} y1={0} x2={CENTER.x} y2={CENTER.y - roadWidth / 2} stroke="#5a5f6a" strokeDasharray="6 6" />
      <line
        x1={CENTER.x}
        y1={CENTER.y + roadWidth / 2}
        x2={CENTER.x}
        y2={SCENE_SIZE}
        stroke="#5a5f6a"
        strokeDasharray="6 6"
      />
      <line x1={0} y1={CENTER.y} x2={CENTER.x - roadWidth / 2} y2={CENTER.y} stroke="#5a5f6a" strokeDasharray="6 6" />
      <line
        x1={CENTER.x + roadWidth / 2}
        y1={CENTER.y}
        x2={SCENE_SIZE}
        y2={CENTER.y}
        stroke="#5a5f6a"
        strokeDasharray="6 6"
      />
      <Crosswalks state={state} />
      <QueuedVehicles state={state} />
      <CrossingVehicles crossing={state.crossing} />
      <Pedestrians state={state} />
      <TrafficLights state={state} />
    </svg>
  );
}
