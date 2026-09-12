import { PHASE_LABEL, currentWaitOf, lightStateFor, queueLength } from "../utils/trafficSim";

const MAX_SHOWN = 16; // queue length at which the congestion gauge reads "full"

function congestionColor(pct) {
  if (pct < 40) return "var(--accent)";
  if (pct < 75) return "var(--warn)";
  return "var(--danger)";
}

function Lane({ orientation, anchor, state, approach, label }) {
  const len = queueLength(state, approach);
  const pct = Math.min(100, (len / MAX_SHOWN) * 100);
  const wait = currentWaitOf(state, approach);
  const sizeProp = orientation === "vertical" ? "height" : "width";

  return (
    <div className={`lane lane-${approach.toLowerCase()}`}>
      <div className="lane-label">{label}</div>
      <div className={`gauge gauge-${orientation}`}>
        <div
          className={`gauge-fill anchor-${anchor}`}
          style={{ [sizeProp]: `${pct}%`, background: congestionColor(pct) }}
        />
      </div>
      <div className="queue-count">{len}대</div>
      {len > 0 && <div className="queue-wait">최장 {Math.round(wait)}초</div>}
    </div>
  );
}

export default function IntersectionView({ title, badge, state }) {
  const lightN = lightStateFor(state, "N");
  const lightS = lightStateFor(state, "S");
  const lightE = lightStateFor(state, "E");
  const lightW = lightStateFor(state, "W");

  return (
    <div className="intersection-card">
      <div className="intersection-head">
        <h2>{title}</h2>
        {badge}
      </div>
      <div className="intersection">
        <Lane orientation="vertical" anchor="bottom" state={state} approach="N" label="북" />
        <Lane orientation="horizontal" anchor="right" state={state} approach="W" label="서" />

        <div className="center-box">
          <span className={`light light-n light-${lightN}`} />
          <span className={`light light-s light-${lightS}`} />
          <span className={`light light-e light-${lightE}`} />
          <span className={`light light-w light-${lightW}`} />
          <div className="phase-readout">
            <span className="phase-name">{PHASE_LABEL[state.phase]}</span>
            <span className="phase-timer">
              {state.yellow ? "전환 중" : `${Math.floor(state.phaseElapsed)}s`}
            </span>
          </div>
        </div>

        <Lane orientation="horizontal" anchor="left" state={state} approach="E" label="동" />
        <Lane orientation="vertical" anchor="top" state={state} approach="S" label="남" />
      </div>
    </div>
  );
}
