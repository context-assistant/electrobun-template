import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  abcdef,
  androidstudio,
  andromeda,
  atomone,
  aura,
  copilot,
  darcula,
  dracula,
  duotoneDark,
  githubDark,
  githubLight,
  gruvboxDark,
  gruvboxLight,
  kimbie,
  noctisLilac,
  quietlight,
  red,
  solarizedDark,
  solarizedLight,
  sublime,
  tokyoNight,
  tokyoNightDay,
  tokyoNightStorm,
  tomorrowNightBlue,
  xcodeDark,
  xcodeLight,
} from "@uiw/codemirror-themes-all";
import { CustomSelect } from "./CustomSelect";
import { FrameKebabMenu } from "./FrameTabBar";
import { resolveLanguageExtensions } from "../lib/codemirrorLanguages";
import {
  getEditorThemeSelectOptions,
  type EditorThemeOption,
} from "../lib/editorThemes";

type Props = {
  path: string;
  leftLabel: string;
  rightLabel: string;
  leftValue: string;
  rightValue: string;
  onClose: () => void;
};

const THEME_EXTENSION_MAP: Record<string, Extension> = {
  abcdef,
  androidstudio,
  andromeda,
  atomone,
  aura,
  copilot,
  darcula,
  dracula,
  "duotone-dark": duotoneDark,
  "github-dark": githubDark,
  "github-light": githubLight,
  "gruvbox-dark": gruvboxDark,
  "gruvbox-light": gruvboxLight,
  kimbie,
  "one-dark": oneDark,
  quietlight,
  red,
  "solarized-dark": solarizedDark,
  "solarized-light": solarizedLight,
  sublime,
  "tokyo-night": tokyoNight,
  "tokyo-night-storm": tokyoNightStorm,
  "tokyo-night-day": tokyoNightDay,
  "tomorrow-night-blue": tomorrowNightBlue,
  "xcode-dark": xcodeDark,
};

function themeStyles(theme: EditorThemeOption): Extension {
  const editorFontSize = "calc(var(--ca-font-size-px) * 0.75)";
  const selected = THEME_EXTENSION_MAP[theme] ?? tokyoNight;

  const typography = EditorView.theme({
    "&.cm-editor": {
      fontSize: editorFontSize,
    },
    ".cm-content, .cm-gutters, .cm-gutterElement": {
      fontSize: editorFontSize,
    },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    "&.cm-focused": {
      outline: "none",
    },
  });

  return [selected, typography];
}

export function DiffViewer({
  path,
  leftLabel,
  rightLabel,
  leftValue,
  rightValue,
  onClose,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const leftValueRef = useRef(leftValue);
  leftValueRef.current = leftValue;
  const rightValueRef = useRef(rightValue);
  rightValueRef.current = rightValue;
  const [themeSyncNonce, setThemeSyncNonce] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lineWrap, setLineWrap] = useState(true);
  const [theme, setTheme] = useState<EditorThemeOption>("tokyo-night");

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver((mutations) => {
      const changed = mutations.some((mutation) => mutation.attributeName === "class");
      if (!changed) return;
      setThemeSyncNonce((prev) => prev + 1);
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMediaChange = () => setThemeSyncNonce((prev) => prev + 1);
    media?.addEventListener?.("change", onMediaChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", onMediaChange);
    };
  }, []);

  // Create / recreate MergeView when structural config changes (theme, wrap, path).
  // Content values are read from refs so they're always current without triggering recreation.
  useEffect(() => {
    if (!rootRef.current) return;
    const languageExtensions = resolveLanguageExtensions(path);
    const extensions = [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ...(lineWrap ? [EditorView.lineWrapping] : []),
      ...languageExtensions,
      themeStyles(theme),
    ];
    const view = new MergeView({
      parent: rootRef.current,
      a: {
        doc: leftValueRef.current,
        extensions,
      },
      b: {
        doc: rightValueRef.current,
        extensions,
      },
      revertControls: false,
    });
    mergeViewRef.current = view;
    return () => {
      view.destroy();
      mergeViewRef.current = null;
    };
  }, [lineWrap, path, theme, themeSyncNonce]);

  // Update left (a) editor content in-place when leftValue prop changes.
  useEffect(() => {
    const mv = mergeViewRef.current;
    if (!mv) return;
    const editor = mv.a;
    const current = editor.state.doc.toString();
    if (current !== leftValue) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: leftValue } });
    }
  }, [leftValue]);

  // Update right (b) editor content in-place when rightValue prop changes.
  useEffect(() => {
    const mv = mergeViewRef.current;
    if (!mv) return;
    const editor = mv.b;
    const current = editor.state.doc.toString();
    if (current !== rightValue) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: rightValue } });
    }
  }, [rightValue]);

  return (
    <div className="ca-diff-viewer h-full min-h-0 flex flex-col">
      <div className="shrink-0 border-b bg-background/60 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate font-mono">{path}</div>
          <FrameKebabMenu
            open={menuOpen}
            onToggle={() => setMenuOpen((prev) => !prev)}
            onClose={() => setMenuOpen(false)}
            label="Diff viewer options"
            items={[
              {
                id: "line-wrap",
                label: `Line wrap: ${lineWrap ? "On" : "Off"}`,
                onSelect: () => setLineWrap((prev) => !prev),
              },
              {
                id: "close-diff",
                label: "Close diff view",
                onSelect: onClose,
                dividerBefore: true,
                danger: true,
              },
            ]}
            content={
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>Editor theme</span>
                <CustomSelect
                  value={theme}
                  onChange={(v) => setTheme(v as EditorThemeOption)}
                  options={getEditorThemeSelectOptions()}
                  className="rounded px-2 py-1 text-xs"
                />
              </label>
            }
          />
        </div>
        <div className="mt-1 text-muted-foreground">
          <span>{leftLabel}</span>
          <span className="mx-2">vs</span>
          <span>{rightLabel}</span>
        </div>
      </div>
      <div ref={rootRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
