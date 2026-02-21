import { readJSON, writeJSON } from "./localStorage";
import { isEditorThemeOption, type EditorThemeOption } from "./editorThemes";
import { getEditorSemanticColors } from "./editorThemeColors";
import { resolveTerminalTheme } from "./terminalThemes";
import { getStoredThemeBrightness } from "./themeBrightness";
import { getStoredThemeContrast } from "./themeContrast";
import { getStoredThemeSaturation } from "./themeSaturation";
import { isThemeBypassActive } from "./themeBypass";

type ThemeMode = "light" | "dark-day" | "dark-night";
export type AppTheme = EditorThemeOption;

const STORAGE_KEY = "context-assistant.theme.v1";
const CUSTOM_COLORS_KEY = "context-assistant.theme.custom-colors.v1";
const THEME_CHANGED_EVENT = "context-assistant:theme-changed";

const DEFAULT_APP_THEME = "tokyo-night" as const;

export function getStoredTheme(): AppTheme {
  const value = readJSON<unknown>(STORAGE_KEY);
  if (isEditorThemeOption(value)) return value;
  // Migrate legacy system/light/dark to tokyo-night
  if (value === "system" || value === "light" || value === "dark") return DEFAULT_APP_THEME;
  if (value === "dark-day") return "vscode-dark";
  if (value === "dark-night") return "github-dark";
  return DEFAULT_APP_THEME;
}

export function setStoredTheme(theme: AppTheme) {
  writeJSON(STORAGE_KEY, theme);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
  }
}

export function onStoredThemeChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(THEME_CHANGED_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGED_EVENT, handler);
}

function getSystemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
}

function isLightTheme(theme: AppTheme): boolean {
  if (theme.includes("light")) return true;
  if (theme.endsWith("-day")) return true;
  return theme === "quietlight";
}

function toThemeMode(theme: AppTheme): ThemeMode {
  if (isLightTheme(theme)) return "light";
  if (theme === "xcode-dark") return "dark-day";
  return "dark-night";
}

function resolveEditorTheme(theme: AppTheme): EditorThemeOption {
  return theme;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = hex.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(normalized);
  if (short?.[1]) {
    const parts = short[1].split("").map((v) => parseInt(v + v, 16));
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 };
  }
  const full = /^#([0-9a-f]{6})$/i.exec(normalized);
  if (full?.[1]) {
    const value = full[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return { r, g, b };
  }
  return null;
}

function deriveBorderColor(foreground: string, darkMode: boolean): string {
  const rgb = hexToRgb(foreground);
  if (!rgb) return darkMode ? "rgb(255 255 255 / 14%)" : "rgb(0 0 0 / 12%)";
  const alpha = darkMode ? 0.14 : 0.16;
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${alpha})`;
}

function blendHex(baseHex: string, overlayHex: string, amount: number, fallback: string): string {
  const base = hexToRgb(baseHex);
  const overlay = hexToRgb(overlayHex);
  if (!base || !overlay) return fallback;
  const t = Math.max(0, Math.min(1, amount));
  const r = Math.round(base.r + (overlay.r - base.r) * t);
  const g = Math.round(base.g + (overlay.g - base.g) * t);
  const b = Math.round(base.b + (overlay.b - base.b) * t);
  return `rgb(${r} ${g} ${b})`;
}

function pickReadableTextOn(colorHex: string, fallback: string): string {
  const rgb = hexToRgb(colorHex);
  if (!rgb) return fallback;
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance > 0.62 ? "#111827" : "#f9fafb";
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

const RGB_MIDPOINT = 127.5;

/** Apply contrast to a hex color. factor: 0.5 = compress, 1 = no change, 1.5 = expand. */
function applyContrastToHex(hex: string, factor: number, fallback: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  const f = Math.max(0, factor);
  const r = Math.round(Math.min(255, Math.max(0, RGB_MIDPOINT + (rgb.r - RGB_MIDPOINT) * f)));
  const g = Math.round(Math.min(255, Math.max(0, RGB_MIDPOINT + (rgb.g - RGB_MIDPOINT) * f)));
  const b = Math.round(Math.min(255, Math.max(0, RGB_MIDPOINT + (rgb.b - RGB_MIDPOINT) * f)));
  return rgbToHex(r, g, b);
}

/** Apply contrast to rgb(r g b / alpha) string. */
function applyContrastToRgb(rgbStr: string, factor: number): string {
  const match = /rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([^)]+)\)/.exec(rgbStr);
  if (!match) return rgbStr;
  const [, r, g, b, alpha] = match;
  const hex = rgbToHex(Number(r), Number(g), Number(b));
  const adjusted = applyContrastToHex(hex, factor, rgbStr);
  const adjRgb = hexToRgb(adjusted);
  if (!adjRgb) return rgbStr;
  return `rgb(${adjRgb.r} ${adjRgb.g} ${adjRgb.b} / ${alpha})`;
}

/** Apply brightness to a hex color. amount: -1 (darker) to 1 (brighter), 0 = no change. */
function applyBrightnessToHex(hex: string, amount: number, fallback: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  const t = Math.max(-1, Math.min(1, amount));
  const target = t < 0 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const blend = Math.abs(t);
  const r = rgb.r + (target.r - rgb.r) * blend;
  const g = rgb.g + (target.g - rgb.g) * blend;
  const b = rgb.b + (target.b - rgb.b) * blend;
  return rgbToHex(r, g, b);
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

/** Apply saturation to a hex color. factor: 0 = gray, 1 = no change, 2 = double saturation. */
function applySaturationToHex(hex: string, factor: number, fallback: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const newS = Math.min(1, Math.max(0, s * factor));
  const out = hslToRgb(h, newS, l);
  return rgbToHex(out.r, out.g, out.b);
}

/** Shift hue of a hex color by degrees (0-360). */
function hueShiftHex(hex: string, degrees: number, fallback: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return fallback;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const newH = ((h * 360 + degrees) % 360) / 360;
  const out = hslToRgb(newH, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

/** Apply saturation to rgb(r g b / alpha) string. */
function applySaturationToRgb(rgbStr: string, factor: number): string {
  const match = /rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([^)]+)\)/.exec(rgbStr);
  if (!match) return rgbStr;
  const [, r, g, b, alpha] = match;
  const hex = rgbToHex(Number(r), Number(g), Number(b));
  const adjusted = applySaturationToHex(hex, factor, rgbStr);
  const adjRgb = hexToRgb(adjusted);
  if (!adjRgb) return rgbStr;
  return `rgb(${adjRgb.r} ${adjRgb.g} ${adjRgb.b} / ${alpha})`;
}

/** Apply brightness to rgb(r g b / alpha) string. */
function applyBrightnessToRgb(rgbStr: string, amount: number): string {
  const match = /rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([^)]+)\)/.exec(rgbStr);
  if (!match) return rgbStr;
  const [, r, g, b, alpha] = match;
  const hex = rgbToHex(Number(r), Number(g), Number(b));
  const adjusted = applyBrightnessToHex(hex, amount, rgbStr);
  const adjRgb = hexToRgb(adjusted);
  if (!adjRgb) return rgbStr;
  return `rgb(${adjRgb.r} ${adjRgb.g} ${adjRgb.b} / ${alpha})`;
}

export type FileBrowserColors = {
  json: string;
  code: string;
  config: string;
  markdown: string;
  image: string;
  video: string;
  audio: string;
  model3d: string;
  folder: string;
  git: string;
  default: string;
};

export type ThemePaletteColors = {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  border: string;
  accent: string;
  fileBrowser: FileBrowserColors;
};

export function getStoredCustomColors(): Partial<ThemePaletteColors> | null {
  const raw = readJSON<unknown>(CUSTOM_COLORS_KEY);
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const result: Partial<ThemePaletteColors> = {};
  const keys: Exclude<keyof ThemePaletteColors, "fileBrowser">[] = [
    "background",
    "foreground",
    "primary",
    "primaryForeground",
    "secondary",
    "secondaryForeground",
    "muted",
    "border",
    "accent",
  ];
  for (const k of keys) {
    if (typeof o[k] === "string") result[k] = o[k] as ThemePaletteColors[typeof k];
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function setStoredCustomColors(colors: Partial<ThemePaletteColors> | null): void {
  if (colors && Object.keys(colors).length > 0) {
    writeJSON(CUSTOM_COLORS_KEY, colors);
  } else {
    writeJSON(CUSTOM_COLORS_KEY, null);
  }
}

/** Compute theme palette colors for given theme and adjustment params. */
export function computeThemePalette(
  theme: AppTheme,
  brightness: number,
  contrast: number,
  saturation: number,
): ThemePaletteColors {
  const mode = toThemeMode(theme);
  const resolvedTheme = resolveEditorTheme(theme);
  const terminalTheme = resolveTerminalTheme(resolvedTheme);
  const semantic = getEditorSemanticColors(resolvedTheme, mode !== "light");
  const background = terminalTheme.background ?? (mode === "light" ? "#ffffff" : "#1e1e1e");
  const foreground = terminalTheme.foreground ?? (mode === "light" ? "#1f2328" : "#d4d4d4");
  const border = deriveBorderColor(foreground, mode !== "light");
  // Primary: variable token color (better for buttons, links)
  const primarySource = blendHex(
    background,
    semantic.secondary,
    // semantic.primary,
    0.4, 
    mode === "light" ? "rgb(245 245 245)" : "rgb(49 49 49)",
  );
  // Accent: function token color (vibrant, good for highlights)
  // const accentSource = semantic.primary;
  const accentSource = semantic.primary;
  const muted = blendHex(
    background,
    semantic.muted,
    // mode === "light" ? 0.12 : 0.2,
    0.2, 
    mode === "light" ? "rgb(245 245 245)" : "rgb(49 49 49)",
  );
  const secondary = blendHex(
    background,
    semantic.secondary,
    // mode === "light" ? 0.15 : 0.22,
    0.2, 
    mode === "light" ? "rgb(236 236 236)" : "rgb(58 58 58)",
  );

  const contrastFactor = contrast / 100;
  const saturationFactor = saturation / 100;
  const brightnessAmount = (brightness - 100) / 100;

  const contrastBackground = applyContrastToHex(background, contrastFactor, background);
  const contrastMuted = applyContrastToHex(muted, contrastFactor, muted);
  const contrastPrimary = applyContrastToHex(primarySource, contrastFactor, primarySource);
  const contrastAccent = applyContrastToHex(accentSource, contrastFactor, accentSource);
  const contrastSecondary = applyContrastToHex(secondary, contrastFactor, secondary);
  const contrastBorder = applyContrastToRgb(border, contrastFactor);

  const satBackground = applySaturationToHex(contrastBackground, saturationFactor, contrastBackground);
  const satMuted = applySaturationToHex(contrastMuted, saturationFactor, contrastMuted);
  const satPrimary = applySaturationToHex(contrastPrimary, saturationFactor, contrastPrimary);
  const satAccent = applySaturationToHex(contrastAccent, saturationFactor, contrastAccent);
  const satSecondary = applySaturationToHex(contrastSecondary, saturationFactor, contrastSecondary);
  const satBorder = applySaturationToRgb(contrastBorder, saturationFactor);

  const adjustedBackground = applyBrightnessToHex(satBackground, brightnessAmount, satBackground);
  const adjustedMuted = applyBrightnessToHex(satMuted, brightnessAmount, satMuted);
  const adjustedPrimary = applyBrightnessToHex(satPrimary, brightnessAmount, satPrimary);
  const adjustedAccent = applyBrightnessToHex(satAccent, brightnessAmount, satAccent);
  const adjustedSecondary = applyBrightnessToHex(satSecondary, brightnessAmount, satSecondary);
  const adjustedBorder = applyBrightnessToRgb(satBorder, brightnessAmount);

  const adjustedForeground = applyContrastToHex(foreground, contrastFactor, foreground);
  const satForeground = applySaturationToHex(adjustedForeground, saturationFactor, adjustedForeground);
  const finalForeground = applyBrightnessToHex(satForeground, brightnessAmount, satForeground);

  const primaryForeground = pickReadableTextOn(adjustedPrimary, mode === "light" ? "#111827" : "#f9fafb");
  const secondaryForeground = finalForeground;

  // File browser colors: derived from semantic palette via hue shifts, then adjusted
  const fbBase = semantic.primary;
  const fbSecondary = semantic.secondary;
  const fbMuted = semantic.muted;
  const applyFb = (hex: string) => {
    const c = applyContrastToHex(hex, contrastFactor, hex);
    const s = applySaturationToHex(c, saturationFactor, c);
    return applyBrightnessToHex(s, brightnessAmount, s);
  };
  const fileBrowser: FileBrowserColors = {
    json: applyFb(hueShiftHex(fbBase, 30, fbBase)),
    code: applyFb(fbBase),
    config: applyFb(fbSecondary),
    markdown: applyFb(hueShiftHex(fbBase, 330, fbBase)),
    image: applyFb(hueShiftHex(fbBase, 150, fbBase)),
    video: applyFb(hueShiftHex(fbBase, 270, fbBase)),
    audio: applyFb(hueShiftHex(fbBase, 300, fbBase)),
    model3d: applyFb(hueShiftHex(fbBase, 25, fbBase)),
    folder: applyFb(hueShiftHex(fbBase, 45, fbBase)),
    git: applyFb(hueShiftHex(fbBase, 140, fbBase)),
    default: applyFb(fbMuted),
  };

  return {
    background: adjustedBackground,
    foreground: finalForeground,
    primary: adjustedPrimary,
    primaryForeground,
    secondary: adjustedSecondary,
    secondaryForeground,
    muted: adjustedMuted,
    border: adjustedBorder,
    accent: adjustedAccent,
    fileBrowser,
  };
}

/** Apply custom color overrides to the document root. */
export function applyCustomThemeColors(colors: Partial<ThemePaletteColors>): void {
  const root = document.documentElement;
  if (colors.background) root.style.setProperty("--background", colors.background);
  if (colors.foreground) root.style.setProperty("--foreground", colors.foreground);
  if (colors.primary) root.style.setProperty("--primary", colors.primary);
  if (colors.primaryForeground) root.style.setProperty("--primary-foreground", colors.primaryForeground);
  if (colors.secondary) root.style.setProperty("--secondary", colors.secondary);
  if (colors.secondaryForeground) root.style.setProperty("--secondary-foreground", colors.secondaryForeground);
  if (colors.muted) root.style.setProperty("--muted", colors.muted);
  if (colors.border) root.style.setProperty("--border", colors.border);
  if (colors.accent) {
    root.style.setProperty("--accent", colors.accent);
    root.style.setProperty("accent-color", colors.accent);
  }
}

/** Convert rgb(r g b / alpha) or hex to #rrggbb for color input. */
export function cssColorToHex(css: string): string {
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(css.trim());
  if (hex?.[1]) {
    return hex[0].length === 4
      ? `#${hex[1][0]}${hex[1][0]}${hex[1][1]}${hex[1][1]}${hex[1][2]}${hex[1][2]}`
      : hex[0];
  }
  const rgb = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*[\d.]+)?\s*\)/.exec(css);
  if (rgb?.[1] != null && rgb?.[2] != null && rgb?.[3] != null) {
    return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  return "#000000";
}

function applyThemePalette(theme: AppTheme, mode: ThemeMode) {
  const root = document.documentElement;
  const bypass = isThemeBypassActive();
  const brightness = bypass ? 100 : getStoredThemeBrightness();
  const contrast = bypass ? 100 : getStoredThemeContrast();
  const saturation = bypass ? 100 : getStoredThemeSaturation();
  const palette = computeThemePalette(theme, brightness, contrast, saturation);

  const resolvedTheme = resolveEditorTheme(theme);
  const semantic = getEditorSemanticColors(resolvedTheme, mode !== "light");

  root.style.setProperty("--background", palette.background);
  root.style.setProperty("--foreground", palette.foreground);
  root.style.setProperty("--border", palette.border);
  root.style.setProperty("--primary", palette.primary);
  root.style.setProperty("--primary-foreground", palette.primaryForeground);
  root.style.setProperty("--muted", palette.muted);
  root.style.setProperty("--secondary", palette.secondary);
  root.style.setProperty("--secondary-foreground", palette.secondaryForeground);
  root.style.setProperty("--muted-foreground", semantic.muted);
  root.style.setProperty("--sidebar-primary", palette.primary);
  root.style.setProperty("--sidebar-primary-foreground", palette.primaryForeground);
  root.style.setProperty("--accent", palette.accent);
  root.style.setProperty("accent-color", palette.accent);

  const fb = palette.fileBrowser;
  root.style.setProperty("--file-browser-json", fb.json);
  root.style.setProperty("--file-browser-code", fb.code);
  root.style.setProperty("--file-browser-config", fb.config);
  root.style.setProperty("--file-browser-markdown", fb.markdown);
  root.style.setProperty("--file-browser-image", fb.image);
  root.style.setProperty("--file-browser-video", fb.video);
  root.style.setProperty("--file-browser-audio", fb.audio);
  root.style.setProperty("--file-browser-model3d", fb.model3d);
  root.style.setProperty("--file-browser-folder", fb.folder);
  root.style.setProperty("--file-browser-git", fb.git);
  root.style.setProperty("--file-browser-default", fb.default);

  const stored = getStoredCustomColors();
  if (stored) applyCustomThemeColors(stored);
}

function applyThemeClasses(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove("dark", "dark-day");

  if (mode === "light") return;

  root.classList.add("dark");
  if (mode === "dark-day") root.classList.add("dark-day");
}

export function applyTheme(theme: AppTheme): () => void {
  const mode = toThemeMode(theme);
  applyThemeClasses(mode);
  applyThemePalette(theme, mode);
  return () => {};
}
