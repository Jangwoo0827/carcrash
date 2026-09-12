import { useCallback, useEffect, useRef, useState } from "react";
import {
  adaptiveController,
  averageWait,
  createSimState,
  fixedController,
  stepSimulation,
} from "../utils/trafficSim";
import { SCENARIOS } from "../utils/scenarios";

// Real elapsed time is clamped per tick (not skipped) so a throttled background
// tab still catches back up to wall-clock time over a few ticks instead of
// freezing the sim in one giant burst the moment the tab regains focus.
const MAX_FRAME_DT = 5;
const SUB_STEP = 0.08; // seconds per simulation sub-step, keeps the controllers stable at high speed
const RENDER_HZ = 15; // how often we push a re-render (the sim itself still steps every tick)
const TICK_MS = 50; // setInterval, not requestAnimationFrame — keeps firing in background tabs
const HISTORY_SAMPLE_INTERVAL = 3; // sim-seconds between comparison-chart samples
const HISTORY_MAX_POINTS = 240;

export function useTrafficDuel({ scenarioId, speed, running }) {
  const seedRef = useRef(Math.floor(Math.random() * 1e9));
  const fixedRef = useRef(createSimState(seedRef.current));
  const aiRef = useRef(createSimState(seedRef.current));
  const lastTickRef = useRef(null);
  const renderAccumRef = useRef(0);
  const historyRef = useRef([]);
  const lastSampleRef = useRef(0);
  const [, forceRender] = useState(0);

  const reset = useCallback(() => {
    seedRef.current = Math.floor(Math.random() * 1e9);
    fixedRef.current = createSimState(seedRef.current);
    aiRef.current = createSimState(seedRef.current);
    lastTickRef.current = null;
    historyRef.current = [];
    lastSampleRef.current = 0;
    forceRender((n) => n + 1);
  }, []);

  useEffect(() => {
    function tick() {
      const now = Date.now();
      if (lastTickRef.current == null) lastTickRef.current = now;
      const rawDt = Math.min((now - lastTickRef.current) / 1000, MAX_FRAME_DT);
      lastTickRef.current = now;

      if (running && rawDt > 0) {
        const scaledDt = rawDt * speed;
        const steps = Math.max(1, Math.ceil(scaledDt / SUB_STEP));
        const subDt = scaledDt / steps;
        const rates = SCENARIOS[scenarioId].rates;
        for (let i = 0; i < steps; i++) {
          stepSimulation(fixedRef.current, subDt, { arrivalRates: rates, controller: fixedController });
          stepSimulation(aiRef.current, subDt, { arrivalRates: rates, controller: adaptiveController });
        }

        if (aiRef.current.time - lastSampleRef.current >= HISTORY_SAMPLE_INTERVAL) {
          lastSampleRef.current = aiRef.current.time;
          historyRef.current.push({
            t: aiRef.current.time,
            fixedAvg: averageWait(fixedRef.current),
            aiAvg: averageWait(aiRef.current),
          });
          if (historyRef.current.length > HISTORY_MAX_POINTS) historyRef.current.shift();
        }

        renderAccumRef.current += rawDt;
        if (renderAccumRef.current >= 1 / RENDER_HZ) {
          renderAccumRef.current = 0;
          forceRender((n) => n + 1);
        }
      }
    }
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(id);
      lastTickRef.current = null;
    };
  }, [running, speed, scenarioId]);

  return { fixed: fixedRef.current, ai: aiRef.current, history: historyRef.current, reset };
}
