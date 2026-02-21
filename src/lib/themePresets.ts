import { readJSON, writeJSON } from "./localStorage";
import type { AppTheme, ThemePaletteColors } from "./theme";
import { FONT_SIZE_RANGE } from "./fontSize";
import { THEME_BRIGHTNESS_RANGE } from "./themeBrightness";
import { THEME_CONTRAST_RANGE } from "./themeContrast";
import { THEME_SATURATION_RANGE } from "./themeSaturation";
import {
  MAIN_EDITOR_THEME_MATCH_APP,
  SPLIT_EDITOR_THEME_MATCH,
  type MainEditorPaneTheme,
  type SplitEditorPaneTheme,
  type TerminalThemeSetting,
} from "./editorThemes";

const STORAGE_KEY = "context-assistant.theme-presets.v1";

export type ThemePresetData = {
  id: string;
  name: string;
  appTheme: AppTheme;
  brightness: number;
  contrast: number;
  saturation: number;
  mainEditorTheme: MainEditorPaneTheme;
  splitEditorTheme: SplitEditorPaneTheme;
  terminalTheme: TerminalThemeSetting;
  fontSize: number;
  /** Optional custom colors; when present, override computed theme colors. */
  customColors?: Partial<ThemePaletteColors>;
};

export type BuiltInPresetId = "default";

export const BUILT_IN_PRESETS: Record<
  BuiltInPresetId,
  Omit<ThemePresetData, "id" | "name">
> = {
  default: {
    appTheme: "tokyo-night",
    brightness: THEME_BRIGHTNESS_RANGE.defaultValue,
    contrast: 100,
    saturation: 100,
    mainEditorTheme: MAIN_EDITOR_THEME_MATCH_APP,
    splitEditorTheme: MAIN_EDITOR_THEME_MATCH_APP,
    terminalTheme: MAIN_EDITOR_THEME_MATCH_APP,
    fontSize: FONT_SIZE_RANGE.defaultValue,
  },
};

function parsePresets(raw: unknown): ThemePresetData[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ThemePresetData => {
    if (!item || typeof item !== "object") return false;
    const o = item as Record<string, unknown>;
    return (
      typeof o.id === "string" &&
      typeof o.name === "string" &&
      typeof o.appTheme === "string" &&
      typeof o.brightness === "number" &&
      typeof o.contrast === "number" &&
      typeof o.saturation === "number" &&
      typeof o.mainEditorTheme === "string" &&
      typeof o.splitEditorTheme === "string" &&
      typeof o.terminalTheme === "string" &&
      typeof o.fontSize === "number"
    );
  });
}

export function getStoredThemePresets(): ThemePresetData[] {
  const value = readJSON<unknown>(STORAGE_KEY);
  return parsePresets(value);
}

export function saveThemePreset(preset: ThemePresetData): void {
  const presets = getStoredThemePresets();
  const existing = presets.findIndex((p) => p.id === preset.id);
  const next =
    existing >= 0
      ? presets.map((p, i) => (i === existing ? preset : p))
      : [...presets, preset];
  writeJSON(STORAGE_KEY, next);
}

export function deleteThemePreset(id: string): void {
  const presets = getStoredThemePresets().filter((p) => p.id !== id);
  writeJSON(STORAGE_KEY, presets);
}

export function createPresetId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `preset-${Date.now()}`;
}

export function getPresetData(
  id: BuiltInPresetId | string,
): Omit<ThemePresetData, "id" | "name"> | null {
  const builtIn = BUILT_IN_PRESETS[id as keyof typeof BUILT_IN_PRESETS];
  if (builtIn) return builtIn;
  const preset = getStoredThemePresets().find((p) => p.id === id);
  if (!preset) return null;
  const { id: _id, name: _name, ...rest } = preset;
  return rest;
}
