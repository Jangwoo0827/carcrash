import { averageWait, totalDeparted, totalQueued } from "../utils/trafficSim";

export default function MetricsPanel({ fixed, ai }) {
  const fixedAvg = averageWait(fixed);
  const aiAvg = averageWait(ai);
  const improvement = fixedAvg > 0 ? ((fixedAvg - aiAvg) / fixedAvg) * 100 : 0;
  const hasData = totalDeparted(fixed) + totalDeparted(ai) > 0;

  return (
    <div className="metrics-panel">
      <h2 className="card-title">📊 실시간 비교 지표</h2>

      <div className="metrics-grid">
        <div className="metric-col">
          <span className="metric-label">고정 신호</span>
          <span className="metric-value">{fixedAvg.toFixed(1)}초</span>
          <span className="metric-sub">평균 대기시간 · 통과 {totalDeparted(fixed)}대</span>
          <span className="metric-sub muted">현재 대기 {totalQueued(fixed)}대</span>
        </div>
        <div className="metric-col metric-col-ai">
          <span className="metric-label">AI 적응형</span>
          <span className="metric-value">{aiAvg.toFixed(1)}초</span>
          <span className="metric-sub">평균 대기시간 · 통과 {totalDeparted(ai)}대</span>
          <span className="metric-sub muted">현재 대기 {totalQueued(ai)}대</span>
        </div>
      </div>

      <div className={`improvement-banner ${improvement > 0 ? "improvement-positive" : ""}`}>
        {hasData
          ? improvement > 0.5
            ? `🎉 AI 신호가 평균 대기시간을 ${improvement.toFixed(0)}% 줄였어요`
            : improvement < -0.5
              ? `AI 신호가 고정 신호보다 ${Math.abs(improvement).toFixed(0)}% 느려요 (시나리오 확인 필요)`
              : "두 방식이 비슷한 성능을 보이고 있어요"
          : "차량이 통과하면 비교 결과가 나타나요"}
      </div>
    </div>
  );
}
