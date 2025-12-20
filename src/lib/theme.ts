import { readJSON, writeJSON } from "./localStorage";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "context-assistant.theme.v1";

export function getStoredTheme(): ThemeMode {
  const value = readJSON<unknown>(STORAGE_KEY);
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function setStoredTheme(mode: ThemeMode) {
  writeJSON(STORAGE_KEY, mode);
}

function getSystemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function applyDarkClass(isDark: boolean) {
  const root = document.documentElement;
  if (isDark) root.classList.add("dark");
  else root.classList.remove("dark");
}

/**
 * Applies theme and returns a cleanup function (only meaningful for "system").
 */
export function applyTheme(mode: ThemeMode): () => void {
  if (mode === "dark") {
    applyDarkClass(true);
    return () => {};
  }
  if (mode === "light") {
    applyDarkClass(false);
    return () => {};
  }

  // system
  applyDarkClass(getSystemPrefersDark());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => {};

  const handler = () => applyDarkClass(media.matches);
  media.addEventListener?.("change", handler);
  return () => media.removeEventListener?.("change", handler);
}
