import { useCallback, useEffect, useRef, useState } from "react";
import {
  adaptiveController,
  createSimState,
  fixedController,
  stepSimulation,
} from "../utils/trafficSim";
import { SCENARIOS } from "../utils/scenarios";

const MAX_FRAME_DT = 0.25; // clamp so a tab-switch/lag spike doesn't jump the sim forward
const SUB_STEP = 0.08; // seconds per simulation sub-step, keeps the controllers stable at high speed
const RENDER_HZ = 15; // how often we push a re-render (the sim itself still steps every frame)

export function useTrafficDuel({ scenarioId, speed, running }) {
  const seedRef = useRef(Math.floor(Math.random() * 1e9));
  const fixedRef = useRef(createSimState(seedRef.current));
  const aiRef = useRef(createSimState(seedRef.current));
  const lastFrameRef = useRef(null);
  const renderAccumRef = useRef(0);
  const rafRef = useRef(null);
  const [, forceRender] = useState(0);

  const reset = useCallback(() => {
    seedRef.current = Math.floor(Math.random() * 1e9);
    fixedRef.current = createSimState(seedRef.current);
    aiRef.current = createSimState(seedRef.current);
    lastFrameRef.current = null;
    forceRender((n) => n + 1);
  }, []);

  useEffect(() => {
    function loop(now) {
      if (lastFrameRef.current == null) lastFrameRef.current = now;
      const rawDt = Math.min((now - lastFrameRef.current) / 1000, MAX_FRAME_DT);
      lastFrameRef.current = now;

      if (running) {
        const scaledDt = rawDt * speed;
        const steps = Math.max(1, Math.ceil(scaledDt / SUB_STEP));
        const subDt = scaledDt / steps;
        const rates = SCENARIOS[scenarioId].rates;
        for (let i = 0; i < steps; i++) {
          stepSimulation(fixedRef.current, subDt, { arrivalRates: rates, controller: fixedController });
          stepSimulation(aiRef.current, subDt, { arrivalRates: rates, controller: adaptiveController });
        }
        renderAccumRef.current += rawDt;
        if (renderAccumRef.current >= 1 / RENDER_HZ) {
          renderAccumRef.current = 0;
          forceRender((n) => n + 1);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = null;
    };
  }, [running, speed, scenarioId]);

  return { fixed: fixedRef.current, ai: aiRef.current, reset };
}
