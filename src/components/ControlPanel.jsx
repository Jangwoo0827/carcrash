import { SCENARIO_LIST } from "../utils/scenarios";

const SPEEDS = [1, 3, 8];

export default function ControlPanel({
  scenarioId,
  onScenarioChange,
  speed,
  onSpeedChange,
  running,
  onToggleRunning,
  onReset,
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
        <span className="control-label">재생 속도</span>
        <div className="chip-row">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`chip ${speed === s ? "chip-active" : ""}`}
              onClick={() => onSpeedChange(s)}
            >
              {s}x
            </button>
          ))}
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
