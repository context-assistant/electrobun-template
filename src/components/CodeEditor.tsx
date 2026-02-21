import { useEffect, useRef, useState } from "react";
import {
  EditorState,
  Compartment,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { Vim, vim } from "@replit/codemirror-vim";
import { showMinimap } from "@replit/codemirror-minimap";
import { resolveLanguageExtensions } from "../lib/codemirrorLanguages";
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
  duotoneLight,
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
import { oneDark } from "@codemirror/theme-one-dark";
import type { EditorThemeOption } from "../lib/editorThemes";

type EditorTheme = EditorThemeOption | "system" | "light" | "dark";

type Props = {
  /** Used to pick syntax highlighting mode (e.g. `Dockerfile`, `Makefile`). */
  path?: string;
  value: string;
  lineWrap: boolean;
  vimMode: boolean;
  showLineNumbers: boolean;
  showMiniMap: boolean;
  theme: EditorTheme;
  readOnly?: boolean;
  onFocus?: () => void;
  /** When this number changes, the editor will focus itself. */
  focusNonce?: number;
  onChange: (value: string) => void;
  onSave?: () => void;
  vimHost?: VimHost;
};

export type VimHost = {
  resolvePathKind?: (
    path: string,
  ) =>
    | "file"
    | "directory"
    | "missing"
    | Promise<"file" | "directory" | "missing">;
  write?: () => void | Promise<void>;
  saveAs?: (path: string) => void | Promise<void>;
  closeSplit?: () => void;
  split?: (direction: "horizontal" | "vertical", path?: string) => void;
  editFile?: (path: string) => void;
  reloadCurrentBuffer?: () => void | Promise<void>;
  focusDirectory?: (path: string) => void | Promise<void>;
  openTemporaryBuffer?: (path: string) => void | Promise<void>;
  quit?: (force: boolean) => void | string;
  writeQuit?: () => void | Promise<void>;
  writeQuitAll?: () => void | Promise<void>;
  terminalFocus?: () => void;
  terminalRun?: (command: string) => void;
  showMessage?: (message: string) => void;
};

function resolveSystemDark() {
  return (
    document.documentElement.classList.contains("dark") ||
    (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false)
  );
}

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

function themeStyles(theme: EditorTheme): Extension {
  const editorFontSize = "calc(var(--ca-font-size-px) * 0.75)";
  const selected = (() => {
    if (theme === "light") return githubLight;
    if (theme === "dark") return githubDark;
    if (theme === "system") return resolveSystemDark() ? githubDark : githubLight;
    const ext = THEME_EXTENSION_MAP[theme];
    if (ext) return ext;
    return resolveSystemDark() ? githubDark : githubLight;
  })();

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

/** CSS override to hide the line-number gutter that basicSetup always includes. */
const hideLineNumbersTheme = EditorView.theme({
  ".cm-lineNumbers": { display: "none !important" },
});

function minimapExtension(): Extension {
  return showMinimap.of({
    create: () => {
      const dom = document.createElement("div");
      return { dom };
    },
    displayText: "blocks",
    showOverlay: "always",
  });
}

export function CodeEditor({
  path,
  value,
  lineWrap,
  vimMode,
  showLineNumbers,
  showMiniMap,
  theme,
  readOnly = false,
  onFocus,
  focusNonce,
  onChange,
  onSave,
  vimHost,
}: Props) {
  const [themeSyncNonce, setThemeSyncNonce] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onFocusRef = useRef(onFocus);
  const onSaveRef = useRef(onSave);
  const vimHostRef = useRef(vimHost);
  const suppressChangeRef = useRef(false);
  const wrapCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const vimCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const lineNumbersCompartmentRef = useRef(new Compartment());
  const minimapCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    vimHostRef.current = vimHost;
    const view = viewRef.current as any;
    if (view) view.__caVimHost = vimHost;
  }, [vimHost]);

  useEffect(() => {
    if (!rootRef.current || viewRef.current) return;
    const wrapCompartment = wrapCompartmentRef.current;
    const themeCompartment = themeCompartmentRef.current;
    const vimCompartment = vimCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    const lineNumbersCompartment = lineNumbersCompartmentRef.current;
    const minimapCompartment = minimapCompartmentRef.current;
    const languageCompartment = languageCompartmentRef.current;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          languageCompartment.of(path ? resolveLanguageExtensions(path) : [javascript()]),
          keymap.of([indentWithTab]),
          wrapCompartment.of(lineWrap ? EditorView.lineWrapping : []),
          themeCompartment.of(themeStyles(theme)),
          vimCompartment.of(vimMode ? vim() : []),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          lineNumbersCompartment.of(showLineNumbers ? [] : hideLineNumbersTheme),
          minimapCompartment.of(showMiniMap ? minimapExtension() : []),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || suppressChangeRef.current) return;
            onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            focus: () => {
              onFocusRef.current?.();
              return false;
            },
          }),
        ],
      }),
      parent: rootRef.current,
    });

    viewRef.current = view;
    (view as any).__caVimHost = vimHostRef.current;
    (view as any).__caVimWrite = () => onSaveRef.current?.();
    (globalThis as any).__caLastActiveEditorView = view;
    const onFocusIn = () => {
      (globalThis as any).__caLastActiveEditorView = view;
    };
    view.dom.addEventListener("focusin", onFocusIn);
    return () => {
      view.dom.removeEventListener("focusin", onFocusIn);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (typeof focusNonce !== "number") return;
    view.focus();
  }, [focusNonce]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    suppressChangeRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
    suppressChangeRef.current = false;
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        wrapCompartmentRef.current.reconfigure(lineWrap ? EditorView.lineWrapping : []),
        themeCompartmentRef.current.reconfigure(themeStyles(theme)),
        vimCompartmentRef.current.reconfigure(vimMode ? vim() : []),
        readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
        languageCompartmentRef.current.reconfigure(path ? resolveLanguageExtensions(path) : [javascript()]),
        lineNumbersCompartmentRef.current.reconfigure(
          showLineNumbers ? [] : hideLineNumbersTheme,
        ),
        minimapCompartmentRef.current.reconfigure(
          showMiniMap ? minimapExtension() : [],
        ),
      ],
    });
  }, [path, lineWrap, readOnly, theme, vimMode, showLineNumbers, showMiniMap, themeSyncNonce]);

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

  useEffect(() => {
    if (!vimMode) return;
    if ((globalThis as any).__caVimExRegistered) return;
    (globalThis as any).__caVimExRegistered = true;

    const getHost = (cm: any): VimHost | undefined => {
      const view = cm?.cm6 as any;
      return view?.__caVimHost as VimHost | undefined;
    };
    const arg = (params: any) => String(params?.argString ?? "").trim();
    const showHelp = (cm: any, message: string) => {
      const host = getHost(cm);
      if (host?.showMessage) {
        host.showMessage(message);
      }
    };

    Vim.defineEx("help", "h", (cm: any) => {
      showHelp(
        cm,
        [
          "Vim Help",
          "",
          "Custom ex commands",
          ":w  :x  :wq  :wqa  :q  :q!  :saveas {path}",
          ":close  :split|:sp [path]  :vsplit|:vs|:vsp [path]",
          ":edit|:e {path}",
          ":e!  (reload current file from disk, discard in-memory edits)",
          ":terminal|:term [bash command]  (open/focus terminal; runs command in a new tab if provided)",
          "",
          "Core Vim keys",
          "Modes: i a o O (insert), Esc (normal), v (visual), V (line-visual)",
          "Move: h j k l, w b e, 0 $, gg G",
          "Edit: x, dw, diw, dd, yy, p, u, Ctrl-r",
          "Search: /pattern, n, N",
          "Replace: :%s/search/replace",
        ].join("\n"),
      );
    });

    Vim.defineEx("write", "w", (cm: any) => {
      const host = getHost(cm);
      if (host?.write) return void host.write();
      const view = cm?.cm6 as any;
      if (view?.__caVimWrite) return void view.__caVimWrite();
    });
    Vim.defineEx("xit", "x", (cm: any) => {
      const host = getHost(cm);
      if (!host?.writeQuit) return;
      void host.writeQuit();
    });
    Vim.defineEx("wq", undefined, (cm: any) => {
      const host = getHost(cm);
      if (!host?.writeQuit) return;
      void host.writeQuit();
    });
    Vim.defineEx("wqa", undefined, (cm: any) => {
      const host = getHost(cm);
      if (!host?.writeQuitAll) return;
      void host.writeQuitAll();
    });
    Vim.defineEx("wqall", "wqa", (cm: any) => {
      const host = getHost(cm);
      if (!host?.writeQuitAll) return;
      void host.writeQuitAll();
    });
    Vim.defineEx("quit", "q", (cm: any, params: any) => {
      const host = getHost(cm);
      if (!host?.quit) return;
      const force = String(params?.argString ?? "").trimStart().startsWith("!");
      host.quit(force);
    });
    Vim.defineEx("saveas", "sav", (cm: any, params: any) => {
      const host = getHost(cm);
      const a = arg(params);
      if (!host?.saveAs || !a) return;
      void host.saveAs(a);
    });
    Vim.defineEx("savea", undefined, (cm: any, params: any) => {
      const host = getHost(cm);
      const a = arg(params);
      if (!host?.saveAs || !a) return;
      void host.saveAs(a);
    });
    Vim.defineEx("close", "clo", (cm: any) => {
      const host = getHost(cm);
      host?.closeSplit?.();
    });
    Vim.defineEx("split", "sp", (cm: any, params: any) => {
      const host = getHost(cm);
      if (!host?.split) return;
      const a = arg(params);
      host.split("horizontal", a || undefined);
    });
    Vim.defineEx("vsplit", "vs", (cm: any, params: any) => {
      const host = getHost(cm);
      if (!host?.split) return;
      const a = arg(params);
      host.split("vertical", a || undefined);
    });
    Vim.defineEx("vsp", undefined, (cm: any, params: any) => {
      const host = getHost(cm);
      if (!host?.split) return;
      const a = arg(params);
      host.split("vertical", a || undefined);
    });
    Vim.defineEx("edit", "e", (cm: any, params: any) => {
      const host = getHost(cm);
      if (!host) return;
      const input = String((params as any)?.input ?? (params as any)?.cmdline ?? "").trim();
      const rawArgString = String((params as any)?.argString ?? "");
      const bangFromArgString = rawArgString.trimStart().startsWith("!");
      const bang =
        Boolean((params as any)?.bang) ||
        Boolean((params as any)?.force) ||
        bangFromArgString ||
        /^(?:e|edit)!/.test(input);

      let a = arg(params);
      // Some parsers pass `!` as the argString (":e!") or as a prefix (":e! path").
      // Treat both as the bang flag and strip it from the path arg.
      if (a === "!") a = "";
      if (bangFromArgString) a = a.replace(/^!\s*/, "").trim();

      if (bang && !a) {
        if (host.reloadCurrentBuffer) void host.reloadCurrentBuffer();
        else showHelp(cm, "This buffer can't be reloaded (no reloadCurrentBuffer handler).");
        return;
      }
      if (!a) return;
      void (async () => {
        const kind = host.resolvePathKind ? await host.resolvePathKind(a) : "file";
        if (kind === "directory") {
          if (host.focusDirectory) await host.focusDirectory(a);
          return;
        }
        if (kind === "missing") {
          if (host.openTemporaryBuffer) await host.openTemporaryBuffer(a);
          else host.editFile?.(a);
          return;
        }
        host.editFile?.(a);
      })();
    });

    Vim.defineEx("terminal", "term", (cm: any, params: any) => {
      const host = getHost(cm);
      if (!host) return;
      const cmd = String(params?.argString ?? "").trim();
      if (!cmd) {
        host.terminalFocus?.();
        return;
      }
      host.terminalRun?.(cmd);
    });
  }, [vimMode]);

  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const inVimPrompt =
        target instanceof HTMLInputElement &&
        ((target.parentElement?.textContent ?? "").startsWith(":") ||
          (target.closest("span")?.textContent ?? "").startsWith(":"));
      if (!inVimPrompt) return;

      // Keep focus anchored in Vim ":" prompt instead of browser tab navigation.
      event.preventDefault();
      event.stopPropagation();
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.setRangeText("\t", start, end, "end");
    };

    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);

  return <div ref={rootRef} className="h-full min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono" />;
}
