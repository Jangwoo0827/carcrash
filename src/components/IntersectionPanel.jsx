import Scene3D, { PhaseChip } from "./Scene3D";
import ApproachHud from "./ApproachHud";

export default function IntersectionPanel({ title, badge, state, viewMode }) {
  return (
    <div className="intersection-card">
      <div className="intersection-head">
        <h2>{title}</h2>
        {badge}
        <PhaseChip state={state} />
      </div>
      <div className="canvas-wrap">
        <Scene3D state={state} viewMode={viewMode} />
        <ApproachHud state={state} />
      </div>
    </div>
  );
}
