import { readJSON, writeJSON } from "./localStorage";

const STORAGE_KEY = "context-assistant.font-size.v1";
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 22;
const DEFAULT_FONT_SIZE = 16;

export function clampFontSize(value: number) {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, value));
}

export function getStoredFontSize() {
  const value = readJSON<unknown>(STORAGE_KEY);
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_FONT_SIZE;
  return clampFontSize(value);
}

export function setStoredFontSize(value: number) {
  writeJSON(STORAGE_KEY, clampFontSize(value));
}

export function applyFontSize(value: number) {
  const clamped = clampFontSize(value);
  document.documentElement.style.setProperty("--ca-font-size-px", `${clamped * 1.25}px`);
}

export function applyStoredFontSize() {
  applyFontSize(getStoredFontSize());
}

export const FONT_SIZE_RANGE = {
  min: MIN_FONT_SIZE,
  max: MAX_FONT_SIZE,
  defaultValue: DEFAULT_FONT_SIZE,
};
