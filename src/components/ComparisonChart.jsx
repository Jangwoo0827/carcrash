const WIDTH = 560;
const HEIGHT = 170;
const PAD_L = 34;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

function buildPath(points, xScale, yScale, key) {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(1)},${yScale(p[key]).toFixed(1)}`).join(" ");
}

function Chart({ title, history, fixedKey, aiKey, emptyText }) {
  const hasData = history.some((h) => h[fixedKey] > 0 || h[aiKey] > 0);
  const maxY = Math.max(2, ...history.map((h) => Math.max(h[fixedKey], h[aiKey]))) * 1.15;
  const minT = history[0].t;
  const maxT = history[history.length - 1].t;
  const spanT = Math.max(1, maxT - minT);

  const xScale = (t) => PAD_L + ((t - minT) / spanT) * (WIDTH - PAD_L - PAD_R);
  const yScale = (v) => HEIGHT - PAD_B - (v / maxY) * (HEIGHT - PAD_T - PAD_B);

  const gridLines = [0, 0.5, 1].map((f) => Math.round(maxY * f));

  return (
    <div className="chart-block">
      <h3 className="chart-title">{title}</h3>
      {hasData ? (
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="comparison-chart" preserveAspectRatio="none">
          {gridLines.map((v) => (
            <g key={v}>
              <line x1={PAD_L} y1={yScale(v)} x2={WIDTH - PAD_R} y2={yScale(v)} className="chart-grid" />
              <text x={PAD_L - 6} y={yScale(v) + 3} className="chart-axis-label" textAnchor="end">
                {v}s
              </text>
            </g>
          ))}
          <path d={buildPath(history, xScale, yScale, fixedKey)} className="chart-line chart-line-fixed" />
          <path d={buildPath(history, xScale, yScale, aiKey)} className="chart-line chart-line-ai" />
        </svg>
      ) : (
        <p className="empty">{emptyText}</p>
      )}
    </div>
  );
}

export default function ComparisonChart({ history }) {
  if (history.length < 2) {
    return <p className="empty">데이터가 쌓이면 평균 대기시간 추이 그래프가 나타나요.</p>;
  }

  return (
    <div className="chart-wrap">
      <div className="chart-grid-2">
        <Chart
          title="🚗 차량 평균 대기시간"
          history={history}
          fixedKey="fixedAvg"
          aiKey="aiAvg"
          emptyText="차량이 통과하면 그래프가 나타나요."
        />
        <Chart
          title="🚶 보행자 평균 대기시간"
          history={history}
          fixedKey="fixedPedAvg"
          aiKey="aiPedAvg"
          emptyText="보행자 수를 0보다 크게 설정하면 그래프가 나타나요."
        />
      </div>
      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-dot legend-fixed" /> 고정 신호
        </span>
        <span className="legend-item">
          <span className="legend-dot legend-ai" /> AI 적응형
        </span>
      </div>
    </div>
  );
}
