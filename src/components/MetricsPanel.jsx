import {
  averagePedWait,
  averageWait,
  totalDeparted,
  totalPedServed,
  totalPedWaiting,
  totalQueued,
} from "../utils/trafficSim";

function improvementText(label, fixedAvg, aiAvg, hasData, noDataText, worseHint) {
  if (!hasData) return { text: noDataText, positive: false };
  const pct = fixedAvg > 0 ? ((fixedAvg - aiAvg) / fixedAvg) * 100 : 0;
  if (pct > 0.5) return { text: `🎉 ${label} 평균 대기시간이 ${pct.toFixed(0)}% 줄었어요`, positive: true };
  if (pct < -0.5) return { text: `${label}은 고정 신호보다 ${Math.abs(pct).toFixed(0)}% 길어요${worseHint}`, positive: false };
  return { text: `${label}: 두 방식이 비슷해요`, positive: false };
}

export default function MetricsPanel({ fixed, ai }) {
  const fixedAvg = averageWait(fixed);
  const aiAvg = averageWait(ai);
  const fixedPed = averagePedWait(fixed);
  const aiPed = averagePedWait(ai);
  const hasVehicles = totalDeparted(fixed) + totalDeparted(ai) > 0;
  const hasPeds = totalPedServed(fixed) + totalPedServed(ai) > 0;

  const vehicle = improvementText("🚗 차량", fixedAvg, aiAvg, hasVehicles, "차량이 통과하면 비교 결과가 나타나요", " (시나리오 확인 필요)");
  const ped = improvementText("🚶 보행자", fixedPed, aiPed, hasPeds, "보행자가 건너면 비교 결과가 나타나요", "");

  return (
    <div className="metrics-panel">
      <h2 className="card-title">📊 실시간 비교 지표</h2>

      <div className="metrics-grid">
        <div className="metric-col">
          <span className="metric-label">고정 신호</span>
          <span className="metric-kind">🚗 차량 평균 대기</span>
          <span className="metric-value">{fixedAvg.toFixed(1)}초</span>
          <span className="metric-sub">통과 {totalDeparted(fixed)}대 · 현재 대기 {totalQueued(fixed)}대</span>
          <span className="metric-kind">🚶 보행자 평균 대기</span>
          <span className="metric-value metric-value-ped">{fixedPed.toFixed(1)}초</span>
          <span className="metric-sub">건넘 {totalPedServed(fixed)}명 · 현재 대기 {totalPedWaiting(fixed)}명</span>
        </div>
        <div className="metric-col metric-col-ai">
          <span className="metric-label">AI 적응형</span>
          <span className="metric-kind">🚗 차량 평균 대기</span>
          <span className="metric-value">{aiAvg.toFixed(1)}초</span>
          <span className="metric-sub">통과 {totalDeparted(ai)}대 · 현재 대기 {totalQueued(ai)}대</span>
          <span className="metric-kind">🚶 보행자 평균 대기</span>
          <span className="metric-value metric-value-ped">{aiPed.toFixed(1)}초</span>
          <span className="metric-sub">건넘 {totalPedServed(ai)}명 · 현재 대기 {totalPedWaiting(ai)}명</span>
        </div>
      </div>

      <div className={`improvement-banner ${vehicle.positive ? "improvement-positive" : ""}`}>{vehicle.text}</div>
      <div className={`improvement-banner improvement-ped ${ped.positive ? "improvement-positive" : ""}`}>{ped.text}</div>
    </div>
  );
}
