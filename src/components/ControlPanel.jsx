import { SCENARIO_LIST } from "../utils/scenarios";

const SPEED_PRESETS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const MAX_SPEED = 256;

export default function ControlPanel({
  scenarioId,
  onScenarioChange,
  speed,
  onSpeedChange,
  running,
  onToggleRunning,
  onReset,
  viewMode,
  onViewModeChange,
}) {
  return (
    <div className="control-panel">
      <div className="control-group">
        <span className="control-label">교통 시나리오</span>
        <div className="chip-row">
          {SCENARIO_LIST.map((s) => (
            <button
              key={s.id}
              className={`chip ${scenarioId === s.id ? "chip-active" : ""}`}
              onClick={() => onScenarioChange(s.id)}
            >
              {s.emoji} {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="control-group">
        <span className="control-label">재생 속도 (직접 입력 가능, 최대 {MAX_SPEED}x)</span>
        <div className="chip-row">
          {SPEED_PRESETS.map((s) => (
            <button
              key={s}
              className={`chip ${speed === s ? "chip-active" : ""}`}
              onClick={() => onSpeedChange(s)}
            >
              {s}x
            </button>
          ))}
        </div>
        <div className="speed-slider-row">
          <input
            type="range"
            min="1"
            max={MAX_SPEED}
            step="1"
            value={Math.min(MAX_SPEED, Math.round(speed))}
            onChange={(e) => onSpeedChange(Number(e.target.value))}
            className="speed-slider"
          />
          <input
            type="number"
            min="1"
            max={MAX_SPEED}
            value={speed}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isNaN(v)) onSpeedChange(Math.max(1, Math.min(MAX_SPEED, v)));
            }}
            className="speed-number"
          />
          <span className="speed-unit">x</span>
        </div>
      </div>

      <div className="control-group">
        <span className="control-label">보기 모드</span>
        <div className="chip-row">
          <button
            className={`chip ${viewMode === "2d" ? "chip-active" : ""}`}
            onClick={() => onViewModeChange("2d")}
          >
            🔲 2D (탑뷰)
          </button>
          <button
            className={`chip ${viewMode === "3d" ? "chip-active" : ""}`}
            onClick={() => onViewModeChange("3d")}
          >
            🧊 3D (드래그로 회전)
          </button>
        </div>
      </div>

      <div className="control-group control-actions">
        <button className="cta-btn small" onClick={onToggleRunning}>
          {running ? "일시정지" : "재생"}
        </button>
        <button className="cta-btn small ghost" onClick={onReset}>
          새 시나리오로 초기화
        </button>
      </div>
    </div>
  );
}
