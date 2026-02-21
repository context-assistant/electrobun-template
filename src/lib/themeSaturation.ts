import { readJSON, writeJSON } from "./localStorage";

const STORAGE_KEY = "context-assistant.theme-saturation.v1";
const THEME_SATURATION_CHANGED_EVENT = "context-assistant:theme-saturation-changed";

const MIN_SATURATION = 0;
const MAX_SATURATION = 200;
const DEFAULT_SATURATION = 100;

export function clampThemeSaturation(value: number) {
  return Math.min(MAX_SATURATION, Math.max(MIN_SATURATION, value));
}

export function getStoredThemeSaturation() {
  const value = readJSON<unknown>(STORAGE_KEY);
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_SATURATION;
  return clampThemeSaturation(value);
}

export function setStoredThemeSaturation(value: number) {
  const clamped = clampThemeSaturation(value);
  writeJSON(STORAGE_KEY, clamped);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_SATURATION_CHANGED_EVENT));
  }
}

export function onStoredThemeSaturationChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(THEME_SATURATION_CHANGED_EVENT, handler);
  return () => window.removeEventListener(THEME_SATURATION_CHANGED_EVENT, handler);
}

export const THEME_SATURATION_RANGE = {
  min: MIN_SATURATION,
  max: MAX_SATURATION,
  defaultValue: DEFAULT_SATURATION,
};
