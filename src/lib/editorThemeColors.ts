/**
 * Semantic color map derived from CodeMirror editor themes.
 * Maps editor syntax highlighting roles to app UI roles:
 * - primary: function color (what the theme uses for function names)
 * - secondary: variable/property color
 * - muted: comment color
 */
import type { EditorThemeOption } from "./editorThemes";

export type SemanticColors = {
  primary: string;
  secondary: string;
  muted: string;
};

const SEMANTIC_MAP: Partial<Record<EditorThemeOption, SemanticColors>> = {
  aura: { primary: "#82aaff", secondary: "#c792ea", muted: "#636da6" },
  "github-dark": {
    primary: "#ffab70", // atom, bool, special(variableName)
    secondary: "#79c0ff", // variableName
    muted: "#8b949e", // comment
  },
  "github-light": {
    primary: "#e36209", // atom, bool, special(variableName)
    secondary: "#005cc5", // variableName
    muted: "#6a737d", // comment
  },
  "duotone-dark": {
    primary: "#9a86fd", // propertyName
    secondary: "#eeebff", // variableName
    muted: "#6c6783", // comment
  },
  "gruvbox-dark": {
    primary: "#b8bb26", // function(variableName)
    secondary: "#83a598", // variableName
    muted: "#928374", // comment
  },
  "gruvbox-light": {
    primary: "#79740e", // function(variableName)
    secondary: "#076678", // variableName
    muted: "#928374", // comment
  },
  kimbie: {
    primary: "#7e602c", // function
    secondary: "#dc3958", // variable
    muted: "#a57a4c", // comment
  },
  "one-dark": {
    primary: "#61afef", // function(variableName) malibu
    secondary: "#abb2bf", // definition(name) ivory
    muted: "#7d8799", // comment stone
  },
  red: {
    primary: "#ffb454", // function
    secondary: "#edef7d", // variable
    muted: "#e7c0c0", // comment
  },
  sublime: {
    primary: "#5ab0b0", // function(variableName)
    secondary: "#539ac4", // variableName
    muted: "#a2a9b5", // comment
  },
  "solarized-dark": {
    primary: "#268bd2", // function
    secondary: "#268bd2", // variable
    muted: "#586e75", // comment
  },
  "solarized-light": {
    primary: "#268bd2", // function
    secondary: "#268bd2", // variable
    muted: "#93a1a1", // comment
  },
  "tokyo-night": {
    primary: "#7aa2f7", // function(variableName)
    secondary: "#7aa2f7", // propertyName
    muted: "#444b6a", // comment
  },
  "tokyo-night-storm": {
    primary: "#7aa2f7",
    secondary: "#7aa2f7",
    muted: "#565f89",
  },
  "tokyo-night-day": {
    primary: "#3760bf",
    secondary: "#3760bf",
    muted: "#848cb5",
  },
  "xcode-dark": {
    primary: "#6bdfff", // definition(variableName)
    secondary: "#acf2e4", // variableName
    muted: "#7f8c98", // comment
  },
  androidstudio: { primary: "#ffc66d", secondary: "#9876aa", muted: "#808080" },
  darcula: { primary: "#ffc66d", secondary: "#9876aa", muted: "#808080" },
  dracula: { primary: "#66d9ef", secondary: "#bd93f9", muted: "#6272a4" },
  "tomorrow-night-blue": { primary: "#ff9da4", secondary: "#78a9ff", muted: "#7285b7" },
};

/** Fallback when theme has no semantic map - use generic blue/gray. */
const DARK_FALLBACK: SemanticColors = {
  primary: "#61afef",
  secondary: "#79c0ff",
  muted: "#6e7681",
};

const LIGHT_FALLBACK: SemanticColors = {
  primary: "#0969da",
  secondary: "#0550ae",
  muted: "#656d76",
};

export function getEditorSemanticColors(
  theme: EditorThemeOption,
  darkMode: boolean
): SemanticColors {
  const key = theme;
  if (key && SEMANTIC_MAP[key]) {
    return SEMANTIC_MAP[key]!;
  }
  return darkMode ? DARK_FALLBACK : LIGHT_FALLBACK;
}
