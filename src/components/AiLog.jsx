export default function AiLog({ log, confidence }) {
  const entries = [...log].reverse();

  return (
    <div className="ai-log-panel">
      <div className="section-head">
        <h2 className="card-title">🤖 AI 판단 로그</h2>
        {typeof confidence === "number" && (
          <span className="confidence-chip">확신도 {confidence}%</span>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="empty">아직 신호 전환 판단이 없어요. 재생을 눌러보세요.</p>
      ) : (
        <ul className="ai-log-list">
          {entries.map((e) => (
            <li key={e.id} className={`ai-log-item ${e.kind === "thought" ? "ai-log-thought" : "ai-log-switch"}`}>
              <span className="ai-log-time">{e.time.toFixed(0)}s</span>
              <span className="ai-log-message">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
