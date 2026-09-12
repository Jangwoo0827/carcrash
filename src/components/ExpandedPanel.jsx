import { useEffect } from "react";
import Scene3D from "./Scene3D";
import Scene2D from "./Scene2D";
import PhaseChip from "./PhaseChip";
import ApproachHud from "./ApproachHud";

export default function ExpandedPanel({ title, badge, state, viewMode, onViewModeChange, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="expanded-overlay">
      <div className="expanded-head">
        <h2>{title}</h2>
        {badge}
        <PhaseChip state={state} />
        <div className="expanded-actions">
          <button className="chip" onClick={() => onViewModeChange(viewMode === "3d" ? "2d" : "3d")}>
            {viewMode === "3d" ? "🔲 2D로 전환" : "🧊 3D로 전환"}
          </button>
          <button className="expand-close-btn" onClick={onClose} aria-label="닫기">
            ✕ 닫기
          </button>
        </div>
      </div>
      <div className="expanded-canvas-wrap">
        {viewMode === "3d" ? <Scene3D state={state} /> : <Scene2D state={state} />}
        <ApproachHud state={state} />
      </div>
    </div>
  );
}
