import { readJSON, writeJSON } from "./localStorage";

const STORAGE_KEY = "context-assistant.theme-contrast.v1";
const THEME_CONTRAST_CHANGED_EVENT = "context-assistant:theme-contrast-changed";

const MIN_CONTRAST = 0;
const MAX_CONTRAST = 200;
const DEFAULT_CONTRAST = 100;

export function clampThemeContrast(value: number) {
  return Math.min(MAX_CONTRAST, Math.max(MIN_CONTRAST, value));
}

export function getStoredThemeContrast() {
  const value = readJSON<unknown>(STORAGE_KEY);
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_CONTRAST;
  return clampThemeContrast(value);
}

export function setStoredThemeContrast(value: number) {
  const clamped = clampThemeContrast(value);
  writeJSON(STORAGE_KEY, clamped);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_CONTRAST_CHANGED_EVENT));
  }
}

export function onStoredThemeContrastChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(THEME_CONTRAST_CHANGED_EVENT, handler);
  return () => window.removeEventListener(THEME_CONTRAST_CHANGED_EVENT, handler);
}

export const THEME_CONTRAST_RANGE = {
  min: MIN_CONTRAST,
  max: MAX_CONTRAST,
  defaultValue: DEFAULT_CONTRAST,
};
