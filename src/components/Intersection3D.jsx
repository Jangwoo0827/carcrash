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
import { crosswalkWalkable, lightStateFor, PHASE_LABEL } from "../utils/trafficSim";

const LANES = ["left", "through", "right"];
const QUEUE_SPACING = 15;
const MAX_QUEUE_SHOWN = 7;
const CAR_COLOR = { through: "#3182f6", left: "#a855f7", right: "#f59e0b", uturn: "#a855f7" };

function deg(rad) {
  return (rad * 180) / Math.PI;
}

function Car({ x, y, angleDeg, movement, faded }) {
  return (
    <div
      className={`car car-${movement}${faded ? " car-queued" : ""}`}
      style={{
        left: x,
        top: y,
        background: CAR_COLOR[movement] ?? CAR_COLOR.through,
        transform: `translate(-50%, -50%) rotate(${angleDeg}deg)`,
      }}
    >
      <span className="car-windshield" />
    </div>
  );
}

function QueuedVehicles({ state, approach }) {
  const a = APPROACH[approach];
  const angleDeg = deg(Math.atan2(a.dir.y, a.dir.x));
  const items = [];
  for (const lane of LANES) {
    const cat = laneCategory(lane);
    const base = stopPoint(approach, cat);
    const queue = state.queues[approach][lane];
    const shown = Math.min(queue.length, MAX_QUEUE_SHOWN);
    for (let i = 0; i < shown; i++) {
      const back = (i + 1) * QUEUE_SPACING;
      items.push(
        <Car
          key={`${approach}-${lane}-${i}`}
          x={base.x - a.dir.x * back}
          y={base.y - a.dir.y * back}
          angleDeg={angleDeg}
          movement={lane}
          faded
        />
      );
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
      dots.push(<div key={p.id} className="pedestrian" style={{ left: x, top: y }} />);
    }
  }
  return dots;
}

function Crosswalk({ approach, walkable }) {
  const geo = crosswalkGeometry(approach);
  const vertical = approach === "N" || approach === "S";
  const length = ROAD_HALF * 2;
  const style = vertical
    ? { left: geo.center.x, top: geo.center.y, width: length, height: 16 }
    : { left: geo.center.x, top: geo.center.y, width: 16, height: length };
  return (
    <div
      className={`crosswalk crosswalk-${vertical ? "h" : "v"} ${walkable ? "crosswalk-walk" : ""}`}
      style={style}
    />
  );
}

function LightPole({ approach, state }) {
  const light = lightStateFor(state, approach);
  const a = APPROACH[approach];
  const pos = {
    x: CENTER.x - a.dir.x * (ROAD_HALF + 14),
    y: CENTER.y - a.dir.y * (ROAD_HALF + 14),
  };
  // offset sideways so the pole sits beside its approach's inbound lane, not on top of it
  const perp = { x: -a.dir.y, y: a.dir.x };
  const sideOffset = 22;
  const finalPos = { x: pos.x + perp.x * sideOffset, y: pos.y + perp.y * sideOffset };
  return (
    <div className="light-pole" style={{ left: finalPos.x, top: finalPos.y }}>
      <span className={`pole-lamp lamp-red ${light === "red" ? "lamp-on" : ""}`} />
      <span className={`pole-lamp lamp-yellow ${light === "yellow" ? "lamp-on" : ""}`} />
      <span className={`pole-lamp lamp-green ${light === "green" ? "lamp-on" : ""}`} />
    </div>
  );
}

export default function Intersection3D({ title, badge, state }) {
  return (
    <div className="intersection-card">
      <div className="intersection-head">
        <h2>{title}</h2>
        {badge}
        <span className="phase-chip">{PHASE_LABEL[state.phase]} {state.yellow ? "전환중" : `${Math.floor(state.phaseElapsed)}s`}</span>
      </div>
      <div className="scene-wrap">
        <div className="scene" style={{ width: SCENE_SIZE, height: SCENE_SIZE }}>
          <div className="ground" />
          <div className="road road-v" />
          <div className="road road-h" />
          <div className="intersection-box" />
          {APPROACHES.map((a) => (
            <Crosswalk key={a} approach={a} walkable={crosswalkWalkable(state, a)} />
          ))}
          {APPROACHES.map((a) => (
            <QueuedVehicles key={a} state={state} approach={a} />
          ))}
          <CrossingVehicles crossing={state.crossing} />
          <Pedestrians state={state} />
          {APPROACHES.map((a) => (
            <LightPole key={a} approach={a} state={state} />
          ))}
        </div>
      </div>
    </div>
  );
}
