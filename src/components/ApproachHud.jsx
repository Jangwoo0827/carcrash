import { APPROACHES, APPROACH_LABEL, lightStateFor, totalApproachQueue } from "../utils/trafficSim";

export default function ApproachHud({ state }) {
  return (
    <div className="hud-overlay">
      {APPROACHES.map((a) => (
        <div key={a} className={`hud-chip hud-${a.toLowerCase()}`}>
          <span className={`hud-light hud-light-${lightStateFor(state, a)}`} />
          <span className="hud-approach-label">{APPROACH_LABEL[a]}</span>
          <span className="hud-stat">🚗{totalApproachQueue(state, a)}</span>
          <span className="hud-stat">🚶{state.pedestrians[a].length}</span>
        </div>
      ))}
    </div>
  );
}
