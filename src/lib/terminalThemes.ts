import type { ITheme } from "@xterm/xterm";
import type { EditorThemeOption } from "./editorThemes";

const DARK_BASE: ITheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

const LIGHT_BASE: ITheme = {
  background: "#ffffff",
  foreground: "#222222",
  cursor: "#222222",
  cursorAccent: "#ffffff",
  selectionBackground: "#cce2ff",
  black: "#000000",
  red: "#cd3131",
  green: "#00a86b",
  yellow: "#b58900",
  blue: "#0451a5",
  magenta: "#a347ba",
  cyan: "#0598bc",
  white: "#666666",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

const THEME_OVERRIDES: Partial<Record<EditorThemeOption, Partial<ITheme>>> = {
  androidstudio: { ...DARK_BASE, background: "#282b2e", foreground: "#a9b7c6", selectionBackground: "#3d4f51" },
  aura: { ...DARK_BASE, background: "#21202e", foreground: "#d4d4d4", selectionBackground: "#3e4451" },
  copilot: { ...DARK_BASE, background: "#1a1b26", foreground: "#c0caf5", selectionBackground: "#33467c" },
  darcula: { ...DARK_BASE, background: "#2b2b2b", foreground: "#a9b7c6", selectionBackground: "#214283" },
  dracula: { ...DARK_BASE, background: "#282a36", foreground: "#f8f8f2", selectionBackground: "#44475a" },
  "duotone-dark": { ...DARK_BASE, background: "#2a2734", foreground: "#9a86fd", selectionBackground: "#403c52" },
  "github-dark": { ...DARK_BASE, background: "#0d1117", foreground: "#c9d1d9", selectionBackground: "#264f78" },
  "github-light": { ...LIGHT_BASE, background: "#ffffff", foreground: "#1f2328", selectionBackground: "#d0d7de99" },
  "gruvbox-dark": { ...DARK_BASE, background: "#282828", foreground: "#ebdbb2", selectionBackground: "#504945" },
  "gruvbox-light": { ...LIGHT_BASE, background: "#fbf1c7", foreground: "#3c3836", selectionBackground: "#d5c4a1" },
  kimbie: { ...DARK_BASE, background: "#221a0f", foreground: "#d3af86", selectionBackground: "#4a3b2e" },
  "one-dark": { ...DARK_BASE, background: "#282c34", foreground: "#abb2bf", selectionBackground: "#3e4451" },
  quietlight: { ...LIGHT_BASE, background: "#f5f5f5", foreground: "#333333", selectionBackground: "#add6ff" },
  red: { ...DARK_BASE, background: "#390000", foreground: "#f8d2d2", selectionBackground: "#5a1f1f" },
  sublime: { ...DARK_BASE, background: "#1f1f1f", foreground: "#f8f8f2", selectionBackground: "#49483e" },
  "tokyo-night": { ...DARK_BASE, background: "#1a1b26", foreground: "#c0caf5", selectionBackground: "#33467c" },
  "tokyo-night-storm": { ...DARK_BASE, background: "#24283b", foreground: "#c0caf5", selectionBackground: "#394b70" },
  "tokyo-night-day": { ...LIGHT_BASE, background: "#e1e2e7", foreground: "#3760bf", selectionBackground: "#b7c3df" },
  "tomorrow-night-blue": { ...DARK_BASE, background: "#002451", foreground: "#ffffff", selectionBackground: "#003f8c" },
  "solarized-dark": { ...DARK_BASE, background: "#002b36", foreground: "#839496", selectionBackground: "#073642" },
  "solarized-light": { ...LIGHT_BASE, background: "#fdf6e3", foreground: "#657b83", selectionBackground: "#eee8d5" },
  "xcode-dark": { ...DARK_BASE, background: "#292a30", foreground: "#f2f2f7", selectionBackground: "#3f4048" },
};

export function resolveTerminalTheme(theme: EditorThemeOption): ITheme {
  const override = THEME_OVERRIDES[theme];
  if (override) return override as ITheme;
  return theme.includes("light") || theme.endsWith("-day") ? LIGHT_BASE : DARK_BASE;
}
