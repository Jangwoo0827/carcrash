// GitHub Pages serves this app from a /carcrash/ subpath, not the domain
// root — BASE_URL is "/" in dev and "/carcrash/" in that production build,
// so public assets must be resolved through it rather than a bare "/".
const base = import.meta.env.BASE_URL;

export const MODEL_URLS = {
  through: `${base}models/glb/car_blue.glb`,
  left: `${base}models/glb/car_purple.glb`,
  uturn: `${base}models/glb/car_purple.glb`,
  right: `${base}models/glb/car_orange.glb`,
  pedestrian: `${base}models/glb/pedestrian.glb`,
  light_red: `${base}models/glb/traffic_light_red.glb`,
  light_yellow: `${base}models/glb/traffic_light_yellow.glb`,
  light_green: `${base}models/glb/traffic_light_green.glb`,
};

export const ALL_MODEL_URLS = Object.values(MODEL_URLS);
