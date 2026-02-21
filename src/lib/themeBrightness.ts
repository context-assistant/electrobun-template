import { readJSON, writeJSON } from "./localStorage";

const STORAGE_KEY = "context-assistant.theme-brightness.v1";
const THEME_BRIGHTNESS_CHANGED_EVENT = "context-assistant:theme-brightness-changed";

const MIN_BRIGHTNESS = 0;
const MAX_BRIGHTNESS = 120;
const DEFAULT_BRIGHTNESS = 100;

export function clampThemeBrightness(value: number) {
  return Math.min(MAX_BRIGHTNESS, Math.max(MIN_BRIGHTNESS, value));
}

export function getStoredThemeBrightness() {
  const value = readJSON<unknown>(STORAGE_KEY);
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_BRIGHTNESS;
  return clampThemeBrightness(value);
}

export function setStoredThemeBrightness(value: number) {
  const clamped = clampThemeBrightness(value);
  writeJSON(STORAGE_KEY, clamped);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_BRIGHTNESS_CHANGED_EVENT));
  }
}

export function onStoredThemeBrightnessChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(THEME_BRIGHTNESS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(THEME_BRIGHTNESS_CHANGED_EVENT, handler);
}

export const THEME_BRIGHTNESS_RANGE = {
  min: MIN_BRIGHTNESS,
  max: MAX_BRIGHTNESS,
  defaultValue: DEFAULT_BRIGHTNESS,
};
