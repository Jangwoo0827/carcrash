import Scene3D from "./Scene3D";
import Scene2D from "./Scene2D";
import PhaseChip from "./PhaseChip";
import ApproachHud from "./ApproachHud";

export default function IntersectionPanel({ title, badge, state, viewMode, onExpand }) {
  return (
    <div className="intersection-card">
      <div className="intersection-head">
        <h2>{title}</h2>
        {badge}
        <PhaseChip state={state} />
        <button className="expand-btn" onClick={onExpand} aria-label="크게 보기" title="크게 보기">
          ⤢
        </button>
      </div>
      <div className="canvas-wrap">
        {viewMode === "3d" ? <Scene3D state={state} /> : <Scene2D state={state} />}
        <ApproachHud state={state} />
      </div>
    </div>
  );
}
