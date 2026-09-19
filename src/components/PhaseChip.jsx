import { PHASE_LABEL } from "../utils/trafficSim";

export default function PhaseChip({ state }) {
  return (
    <span className="phase-chip">
      {state.scramble ? "보행자 전용" : PHASE_LABEL[state.phase]}{" "}
      {state.yellow
        ? "전환중"
        : state.scramble
          ? `${Math.floor(state.scrambleElapsed)}s`
          : state.leadLeft
          ? `보호좌회전 ${Math.floor(state.leadLeftElapsed)}s`
          : `${Math.floor(state.phaseElapsed)}s`}
    </span>
  );
}
