import { useState } from "react";
import "./App.css";
import ControlPanel from "./components/ControlPanel";
import IntersectionView from "./components/IntersectionView";
import MetricsPanel from "./components/MetricsPanel";
import AiLog from "./components/AiLog";
import { useTrafficDuel } from "./hooks/useTrafficDuel";

export default function App() {
  const [scenarioId, setScenarioId] = useState("normal");
  const [speed, setSpeed] = useState(3);
  const [running, setRunning] = useState(true);

  const { fixed, ai, reset } = useTrafficDuel({ scenarioId, speed, running });

  function handleScenarioChange(id) {
    setScenarioId(id);
  }

  function handleReset() {
    reset();
    setRunning(true);
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>🚦 AI 적응형 신호등 시뮬레이터</h1>
        <p className="app-sub">
          같은 교통 상황을 고정 신호와 AI 신호에 동시에 흘려보내 대기시간을 비교해요.
        </p>
      </header>

      <ControlPanel
        scenarioId={scenarioId}
        onScenarioChange={handleScenarioChange}
        speed={speed}
        onSpeedChange={setSpeed}
        running={running}
        onToggleRunning={() => setRunning((r) => !r)}
        onReset={handleReset}
      />

      <div className="duel-grid">
        <IntersectionView title="고정 신호 (기존 방식)" state={fixed} />
        <IntersectionView
          title="AI 적응형 신호"
          state={ai}
          badge={<span className="badge-ai">AI</span>}
        />
      </div>

      <div className="bottom-grid">
        <MetricsPanel fixed={fixed} ai={ai} />
        <AiLog log={ai.stats.log} />
      </div>
    </div>
  );
}
