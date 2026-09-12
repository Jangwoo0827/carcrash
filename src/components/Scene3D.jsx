import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera, PerspectiveCamera, useGLTF } from "@react-three/drei";
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
import { ALL_MODEL_URLS, MODEL_URLS } from "../three/assets";

for (const url of ALL_MODEL_URLS) useGLTF.preload(url);

// geometry.js works in an abstract 0..320 px plane; these GLB models are
// real-world-ish scale (car ~3.9 long, 2.2 wide — see public/models). SCALE
// converts px -> scene units so a lane (ROAD_HALF/3 px wide) comfortably
// fits a car, and QUEUE_SPACING*SCALE clears the car's own length.
const SCALE = 0.3;
const LANES = ["left", "through", "right"];
const QUEUE_SPACING = 15;
const MAX_QUEUE_SHOWN = 8;
const CAR_SCALE = 1;
const PED_SCALE = 1;
const LIGHT_SCALE = 1;

function toScene(p) {
  return [(p.x - CENTER.x) * SCALE, 0, (p.y - CENTER.y) * SCALE];
}

/** Our 2D path angle (atan2 in an x-right/y-down plane) -> a Y-axis rotation
 * for the model, assuming the source GLB's forward axis is +Z. */
function toRotationY(angle2d) {
  return -angle2d + Math.PI / 2;
}

function GltfModel({ url, position, rotationY = 0, scale = 1 }) {
  const { scene } = useGLTF(url);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={cloned} position={position} rotation={[0, rotationY, 0]} scale={scale} />;
}

function QueuedVehicles({ state }) {
  const items = [];
  for (const approach of APPROACHES) {
    const a = APPROACH[approach];
    const angle = Math.atan2(a.dir.y, a.dir.x);
    for (const lane of LANES) {
      const cat = laneCategory(lane);
      const base = stopPoint(approach, cat);
      const queue = state.queues[approach][lane];
      const shown = Math.min(queue.length, MAX_QUEUE_SHOWN);
      for (let i = 0; i < shown; i++) {
        // i=0 sits exactly on the stop line (matches the crossing path's own
        // t=0 point) so departing doesn't visibly snap the car forward.
        const back = i * QUEUE_SPACING;
        const p = { x: base.x - a.dir.x * back, y: base.y - a.dir.y * back };
        items.push(
          <GltfModel
            key={`${approach}-${lane}-${i}`}
            url={MODEL_URLS[lane]}
            position={toScene(p)}
            rotationY={toRotationY(angle)}
            scale={CAR_SCALE}
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
    return (
      <GltfModel
        key={v.id}
        url={MODEL_URLS[v.movement]}
        position={toScene(p)}
        rotationY={toRotationY(p.angle)}
        scale={CAR_SCALE}
      />
    );
  });
}

function Pedestrians({ state }) {
  const dots = [];
  for (const leg of APPROACHES) {
    const geo = crosswalkGeometry(leg);
    for (const p of state.pedestrians[leg]) {
      const x = geo.from.x + (geo.to.x - geo.from.x) * p.progress;
      const y = geo.from.y + (geo.to.y - geo.from.y) * p.progress;
      dots.push(
        <GltfModel key={p.id} url={MODEL_URLS.pedestrian} position={toScene({ x, y })} scale={PED_SCALE} />
      );
    }
  }
  return dots;
}

function TrafficLights({ state }) {
  return APPROACHES.map((approach) => {
    const light = lightStateFor(state, approach);
    const a = APPROACH[approach];
    const perp = { x: -a.dir.y, y: a.dir.x };
    const base = {
      x: CENTER.x - a.dir.x * (ROAD_HALF + 14) + perp.x * 22,
      y: CENTER.y - a.dir.y * (ROAD_HALF + 14) + perp.y * 22,
    };
    return (
      <GltfModel
        key={approach}
        url={MODEL_URLS[`light_${light}`]}
        position={toScene(base)}
        rotationY={toRotationY(Math.atan2(-a.dir.y, -a.dir.x))}
        scale={LIGHT_SCALE}
      />
    );
  });
}

function Crosswalks({ state }) {
  return APPROACHES.map((approach) => {
    const geo = crosswalkGeometry(approach);
    const vertical = approach === "N" || approach === "S";
    const length = (ROAD_HALF * 2 - 6) * SCALE;
    const width = 14 * SCALE;
    const walkable = crosswalkWalkable(state, approach);
    const [x, , z] = toScene(geo.center);
    return (
      <mesh key={approach} position={[x, 0.02, z]} rotation={[-Math.PI / 2, 0, vertical ? 0 : Math.PI / 2]}>
        <planeGeometry args={[width, length]} />
        <meshStandardMaterial color={walkable ? "#e8ecf1" : "#9aa1ab"} />
      </mesh>
    );
  });
}

function Ground() {
  const roadWidth = ROAD_HALF * 2 * SCALE;
  const span = SCENE_SIZE * SCALE;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[span * 1.3, span * 1.3]} />
        <meshStandardMaterial color="#1c1e22" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[roadWidth, span]} />
        <meshStandardMaterial color="#3a3d45" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[span, roadWidth]} />
        <meshStandardMaterial color="#3a3d45" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <planeGeometry args={[roadWidth * 0.98, roadWidth * 0.98]} />
        <meshStandardMaterial color="#44474f" />
      </mesh>
    </group>
  );
}

function CameraRig({ viewMode }) {
  return (
    <>
      <PerspectiveCamera makeDefault={viewMode === "3d"} position={[16, 17, 19]} fov={42} />
      <OrthographicCamera
        makeDefault={viewMode === "2d"}
        position={[0, 30, 0.01]}
        rotation={[-Math.PI / 2, 0, 0]}
        zoom={9}
      />
      {viewMode === "3d" ? (
        <OrbitControls
          enablePan={false}
          minDistance={10}
          maxDistance={42}
          minPolarAngle={0.15}
          maxPolarAngle={Math.PI / 2 - 0.05}
        />
      ) : null}
    </>
  );
}

export default function Scene3D({ state, viewMode }) {
  return (
    <Canvas shadows dpr={[1, 1.5]} frameloop="always">
      <color attach="background" args={["#0c0d10"]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[8, 12, 6]} intensity={1.1} castShadow />
      <CameraRig viewMode={viewMode} />
      <Suspense fallback={null}>
        <Ground />
        <Crosswalks state={state} />
        <QueuedVehicles state={state} />
        <CrossingVehicles crossing={state.crossing} />
        <Pedestrians state={state} />
        <TrafficLights state={state} />
      </Suspense>
    </Canvas>
  );
}

export function PhaseChip({ state }) {
  return (
    <span className="phase-chip">
      {PHASE_LABEL[state.phase]} {state.yellow ? "전환중" : `${Math.floor(state.phaseElapsed)}s`}
    </span>
  );
}
