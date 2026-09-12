import { useState } from "react";
import "./App.css";
import ControlPanel from "./components/ControlPanel";
import IntersectionPanel from "./components/IntersectionPanel";
import MetricsPanel from "./components/MetricsPanel";
import AiLog from "./components/AiLog";
import ComparisonChart from "./components/ComparisonChart";
import { useTrafficDuel } from "./hooks/useTrafficDuel";

export default function App() {
  const [scenarioId, setScenarioId] = useState("normal");
  const [speed, setSpeed] = useState(2);
  const [running, setRunning] = useState(true);
  const [viewMode, setViewMode] = useState("3d");

  const { fixed, ai, history, reset } = useTrafficDuel({ scenarioId, speed, running });

  function handleReset() {
    reset();
    setRunning(true);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>🚦 AI 적응형 신호등 시뮬레이터</h1>
        <p className="app-sub">
          같은 교통 상황을 고정 신호와 AI 신호에 동시에 흘려보내 대기시간을 비교해요. 탭을 벗어나도
          시뮬레이션은 계속 진행돼요.
        </p>
      </header>

      <ControlPanel
        scenarioId={scenarioId}
        onScenarioChange={setScenarioId}
        speed={speed}
        onSpeedChange={setSpeed}
        running={running}
        onToggleRunning={() => setRunning((r) => !r)}
        onReset={handleReset}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      <div className="duel-grid">
        <IntersectionPanel title="고정 신호 (기존 방식)" state={fixed} viewMode={viewMode} />
        <IntersectionPanel
          title="AI 적응형 신호"
          state={ai}
          viewMode={viewMode}
          badge={<span className="badge-ai">AI</span>}
        />
      </div>

      <div className="bottom-grid">
        <MetricsPanel fixed={fixed} ai={ai} />
        <AiLog log={ai.stats.log} confidence={ai.confidence} />
      </div>

      <div className="card chart-card">
        <h2 className="card-title">📈 평균 대기시간 추이 비교</h2>
        <ComparisonChart history={history} />
      </div>
    </div>
  );
}
