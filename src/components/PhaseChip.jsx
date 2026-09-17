import { PHASE_LABEL } from "../utils/trafficSim";

export default function PhaseChip({ state }) {
  return (
    <span className="phase-chip">
      {PHASE_LABEL[state.phase]}{" "}
      {state.yellow
        ? "전환중"
        : state.leadLeft
          ? `보호좌회전 ${Math.floor(state.leadLeftElapsed)}s`
          : `${Math.floor(state.phaseElapsed)}s`}
    </span>
  );
}
