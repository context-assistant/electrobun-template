/**
 * All editor themes from @uiw/codemirror-themes-all plus one-dark.
 * Grouped by Color (vibrant), Dark, and Light for optgroup display.
 */
export const EDITOR_THEME_OPTIONS = [
  // Dark - dark background themes
  "androidstudio",
  "darcula",
  "dracula",
  "github-dark",
  "one-dark",
  "sublime",
  "tokyo-night",
  "tokyo-night-storm",
  "solarized-dark",
  "xcode-dark",
  // Color - vibrant themes with distinctive palettes
  "aura",
  "copilot",
  "duotone-dark",
  "gruvbox-dark",
  "kimbie",
  "red",
  "tomorrow-night-blue",
  // Light - light background themes
  "github-light",
  "gruvbox-light",
  "quietlight",
  "solarized-light",
  "tokyo-night-day",
] as const;

export type EditorThemeOption = (typeof EDITOR_THEME_OPTIONS)[number];

/** Theme group for optgroup display. */
export type ThemeGroup = "Dark" | "Color" | "Light";

const THEME_GROUPS: Record<EditorThemeOption, ThemeGroup> = {
  androidstudio: "Dark",
  darcula: "Dark",
  dracula: "Dark",
  "duotone-dark": "Dark",
  "github-dark": "Dark",
  "one-dark": "Dark",
  sublime: "Dark",
  "tokyo-night": "Dark",
  "tokyo-night-storm": "Dark",
  "solarized-dark": "Dark",
  "xcode-dark": "Dark",

  aura: "Color",
  copilot: "Color",
  "gruvbox-dark": "Color",
  kimbie: "Color",
  red: "Color",
  "tomorrow-night-blue": "Color",

  "github-light": "Light",
  "gruvbox-light": "Light",
  quietlight: "Light",
  "solarized-light": "Light",
  "tokyo-night-day": "Light",
};

/** Options for theme selects, grouped by Color, Dark, Light. */
export function getEditorThemeSelectOptions(): Array<{ value: EditorThemeOption; label: string; group: ThemeGroup }> {
  const order: ThemeGroup[] = ["Dark", "Color", "Light"];
  return EDITOR_THEME_OPTIONS.map((value) => ({
    value,
    label: value,
    group: THEME_GROUPS[value],
  })).sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

export const MAIN_EDITOR_THEME_MATCH_APP = "match-app-theme" as const;
export const TERMINAL_THEME_MATCH_MAIN = "match-main-editor" as const;
export const SPLIT_EDITOR_THEME_MATCH = "match-main" as const;
export type TerminalThemeSetting =
  | EditorThemeOption
  | typeof TERMINAL_THEME_MATCH_MAIN
  | typeof MAIN_EDITOR_THEME_MATCH_APP;
export type MainEditorPaneTheme = EditorThemeOption | typeof MAIN_EDITOR_THEME_MATCH_APP;
export type SplitEditorPaneTheme = MainEditorPaneTheme | typeof SPLIT_EDITOR_THEME_MATCH;

export function isEditorThemeOption(value: unknown): value is EditorThemeOption {
  return typeof value === "string" && (EDITOR_THEME_OPTIONS as readonly string[]).includes(value);
}

export function isTerminalThemeSetting(value: unknown): value is TerminalThemeSetting {
  return (
    value === TERMINAL_THEME_MATCH_MAIN ||
    value === MAIN_EDITOR_THEME_MATCH_APP ||
    isEditorThemeOption(value)
  );
}

export function isMainEditorPaneTheme(value: unknown): value is MainEditorPaneTheme {
  return value === MAIN_EDITOR_THEME_MATCH_APP || isEditorThemeOption(value);
}
