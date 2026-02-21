import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import * as dockerClient from "../lib/docker";
import * as ollamaClient from "../lib/ollama";
import { applyBashAliasesToContainer } from "../lib/bashAliases";
import { onTerminalOutput, onTerminalExit } from "../electrobun/renderer";
import {
  AudioLines,
  Bot,
  Eye,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import type { AIModelInfo, ContainerInfo, OllamaModelInfo } from "../electrobun/rpcSchema";
import type { RemoteSshEndpoint } from "../lib/appStorage";
import { readJSON, writeJSON } from "../lib/localStorage";
import {
  MODEL_TYPE_DISPLAY,
  MODEL_TYPE_LABELS,
  type ProviderModel,
  type ProviderModelType,
} from "../lib/modelProviders";
import { getPrimaryContainerShell } from "../lib/containerShells";
import type { EditorThemeOption } from "../lib/editorThemes";
import { resolveTerminalTheme } from "../lib/terminalThemes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  activeContainerId: string | null;
  containers: ContainerInfo[];
  dockerLocalContainers?: ContainerInfo[];
  dockerRemoteContainers?: ContainerInfo[];
  dockerHost?: string | null;
  ollamaHost?: string | null;
  localTerminalEnabled?: boolean;
  dockerModelEnabled?: boolean;
  ollamaModelEnabled?: boolean;
  dockerLocalEnabled?: boolean;
  dockerRemoteEnabled?: boolean;
  ollamaLocalEnabled?: boolean;
  ollamaRemoteEnabled?: boolean;
  remoteDockerHost?: string | null;
  remoteOllamaHost?: string | null;
  enabledLocalShells?: string[];
  terminalTheme?: EditorThemeOption;
  remoteEndpoints?: RemoteSshEndpoint[];
  dockerLocalModels?: ProviderModel[];
  dockerRemoteModels?: ProviderModel[];
  ollamaLocalModels?: ProviderModel[];
  ollamaRemoteModels?: ProviderModel[];
  onOpenPathCommand: (containerId: string, path: string, kind: "file" | "directory") => void;
  preferredShellCwdByContainerId?: Record<string, string>;
  panelVisible?: boolean;
  controlRef?: React.MutableRefObject<ContainerTerminalControl | null>;
  onActiveSessionReady?: (containerId: string) => void;
  onTabDragStart?: (
    payload: { tabId: string; descriptor: TerminalTabDescriptor },
    event: React.DragEvent<HTMLDivElement>,
  ) => void;
  onTabDragEnd?: () => void;
};

export type TerminalTabKind =
  | "shell"
  | "local-shell"
  | "remote-shell"
  | "docker-run"
  | "model-run"
  | "ollama-run"
  | "ollama-pull"
  | "docker-image-pull"
  | "docker-model-pull";

export type TerminalTabDescriptor = {
  kind: TerminalTabKind;
  containerId: string | null;
  containerName: string | null;
  label: string | null;
  shell?: string | null;
  fixedLabel?: boolean;
  modelName: string | null;
  cwd: string | null;
  sessionId?: string | null;
  dockerHost?: string | null;
  ollamaHost?: string | null;
  initialCommands?: string[] | null;
};

type ShellTab = {
  id: string;
  label: string;
  containerId: string;
  containerName: string;
  kind: TerminalTabKind;
  shell?: string | null;
  fixedLabel?: boolean;
  modelName?: string;
  sessionId: string | null;
  connecting: boolean;
  exited: boolean;
  cwd: string | null;
  dockerHost: string | null;
  ollamaHost: string | null;
};

export type ContainerTerminalControl = {
  focusActive: () => void;
  focusTab: (tabId: string) => void;
  addTab: () => string | null;
  openContainerInNewTab: (containerId: string) => string | null;
  runCommandInNewTab: (command: string) => string | null;
  runModelInNewTab: (modelName: string, dockerHost?: string | null) => string | null;
  runOllamaModelInNewTab: (modelName: string, ollamaHost?: string | null) => string | null;
  pullOllamaModelInNewTab: (modelName: string, ollamaHost?: string | null) => string | null;
  pullDockerImageInNewTab: (imageName: string, dockerHost?: string | null) => string | null;
  pullDockerModelInNewTab: (modelName: string, dockerHost?: string | null) => string | null;
  closeTab: (tabId: string, opts?: { preserveSession?: boolean }) => void;
  getTabDescriptor: (tabId: string) => TerminalTabDescriptor | null;
  openTabFromDescriptor: (descriptor: TerminalTabDescriptor) => string | null;
};

type ShellPaneControl = {
  focus: () => void;
  sendText: (text: string) => void;
  sendLine: (line: string) => void;
};

type PickerModelInfo = {
  id: string;
  name: string;
  size: string;
  source: "docker" | "ollama";
  environment: "local" | "remote";
  host: string | null;
  sourceLabel: string;
};

function renderModelTypeIcon(type: ProviderModelType) {
  switch (type) {
    case "ask":
      return <MessageSquare className="h-3 w-3" />;
    case "agent":
      return <Bot className="h-3 w-3" />;
    case "autocomplete":
      return <Sparkles className="h-3 w-3" />;
    case "vision":
      return <Eye className="h-3 w-3" />;
    case "image":
      return <ImageIcon className="h-3 w-3" />;
    case "video":
      return <Video className="h-3 w-3" />;
    case "tts":
      return <AudioLines className="h-3 w-3" />;
    default:
      return <Sparkles className="h-3 w-3" />;
  }
}

function pickerConfiguredModelKey(
  source: "docker" | "ollama",
  environment: "local" | "remote",
  modelId: string,
): string {
  return `${source}:${environment}:${modelId.trim().toLowerCase()}`;
}

function formatDockerModelDisplayName(modelName: string): string {
  const trimmed = modelName.trim();
  if (!trimmed) return modelName;
  return trimmed.startsWith("docker.io/ai/")
    ? trimmed.slice("docker.io/ai/".length)
    : trimmed;
}

function formatModelTabLabel(modelName: string): string {
  const trimmed = modelName.trim();
  if (!trimmed) return "model";
  const withoutPrefix = formatDockerModelDisplayName(trimmed);
  const withoutDigest = withoutPrefix.split("@")[0] ?? withoutPrefix;
  const tagIdx = withoutDigest.lastIndexOf(":");
  return tagIdx > 0 ? withoutDigest.slice(0, tagIdx) : withoutDigest;
}

let shellTabCounter = 0;
function nextShellTabId() {
  return `shell_${++shellTabCounter}_${Date.now()}`;
}

const TERMINAL_TABS_STORAGE_KEY = "context-assistant.terminal-tabs.v1";

// ---------------------------------------------------------------------------
// Keyboard → terminal data translation
// ---------------------------------------------------------------------------

function keyEventToData(e: KeyboardEvent): string | null {
  // Ignore bare modifier keys
  if (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta"
  ) {
    return null;
  }

  // Let Cmd+key through to browser (copy, paste, new tab, etc.)
  if (e.metaKey) return null;

  // Ctrl+letter → control character
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k.length === 1 && k >= "a" && k <= "z") {
      return String.fromCharCode(k.charCodeAt(0) - 96);
    }
    if (k === "[") return "\x1b";
    if (k === "\\") return "\x1c";
    if (k === "]") return "\x1d";
    return null;
  }

  // Alt+key → ESC prefix (word movement etc.)
  if (e.altKey && e.key.length === 1) return "\x1b" + e.key;

  switch (e.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
  }

  // Printable character
  if (e.key.length === 1) return e.key;
  return null;
}

function isCodeMirrorFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  // CodeMirror 6 focuses a contenteditable element within `.cm-editor`.
  // If an editor has focus, we must not steal keystrokes for the terminal.
  return Boolean(el.closest?.(".cm-editor"));
}

// ---------------------------------------------------------------------------
// Single shell pane — PTY-backed, character-at-a-time
// ---------------------------------------------------------------------------

type ShellPaneProps = {
  tabId: string;
  containerId: string;
  kind: "shell" | "local-shell" | "remote-shell" | "docker-run" | "model-run" | "ollama-run" | "ollama-pull" | "docker-image-pull" | "docker-model-pull";
  shell?: string | null;
  modelName?: string;
  initialSessionId?: string | null;
  dockerHost?: string | null;
  ollamaHost?: string | null;
  activeContainerId: string | null;
  visible: boolean;
  cwd: string | null;
  onSessionExit: (tabId: string, exitCode: number, intentionalClose: boolean) => void;
  onSessionIdChange: (tabId: string, sessionId: string | null) => void;
  onShellDetected: (tabId: string, shell: string) => void;
  onOpenPathCommand: (containerId: string, path: string, kind: "file" | "directory") => void;
  connectRef: React.MutableRefObject<Map<string, () => Promise<void>>>;
  onPaneReady: (tabId: string, control: ShellPaneControl) => void;
  onPaneGone: (tabId: string) => void;
  destroySessionOnUnmount?: boolean;
  terminalTheme?: EditorThemeOption;
};

type SingleTerminalPaneProps = {
  descriptor: TerminalTabDescriptor;
  activeContainerId: string | null;
  containers: ContainerInfo[];
  dockerHost?: string | null;
  ollamaHost?: string | null;
  onOpenPathCommand: (containerId: string, path: string, kind: "file" | "directory") => void;
  preferredShellCwdByContainerId?: Record<string, string>;
  onDescriptorSessionIdChange?: (sessionId: string | null) => void;
  terminalTheme?: EditorThemeOption;
  visible?: boolean;
};

const OPEN_OSC_PREFIX = "\x1b]1337;CA_OPEN_B64=";

function decodeOpenPayload(payloadB64: string): { kind: "file" | "directory"; path: string } | null {
  try {
    const decoded = atob(payloadB64);
    const sep = decoded.indexOf("\t");
    if (sep <= 0) return null;
    const kindRaw = decoded.slice(0, sep);
    const path = decoded.slice(sep + 1).trim();
    if (!path) return null;
    if (kindRaw === "file" || kindRaw === "directory") {
      return { kind: kindRaw, path };
    }
    return null;
  } catch {
    return null;
  }
}

function parseOpenOscCommands(
  chunk: string,
  carry: string,
): {
  displayText: string;
  nextCarry: string;
  commands: Array<{ kind: "file" | "directory"; path: string }>;
} {
  let data = carry + chunk;
  let displayText = "";
  const commands: Array<{ kind: "file" | "directory"; path: string }> = [];

  while (data.length > 0) {
    const start = data.indexOf(OPEN_OSC_PREFIX);
    if (start < 0) {
      displayText += data;
      data = "";
      break;
    }

    displayText += data.slice(0, start);
    const rest = data.slice(start + OPEN_OSC_PREFIX.length);

    const belIdx = rest.indexOf("\x07");
    const stIdx = rest.indexOf("\x1b\\");
    let termIdx = -1;
    let termLen = 0;
    if (belIdx >= 0 && (stIdx < 0 || belIdx < stIdx)) {
      termIdx = belIdx;
      termLen = 1;
    } else if (stIdx >= 0) {
      termIdx = stIdx;
      termLen = 2;
    }

    if (termIdx < 0) {
      const pending = OPEN_OSC_PREFIX + rest;
      return {
        displayText,
        nextCarry: pending.length > 4096 ? pending.slice(-4096) : pending,
        commands,
      };
    }

    const payloadB64 = rest.slice(0, termIdx).trim();
    const command = decodeOpenPayload(payloadB64);
    if (command) {
      commands.push(command);
    }

    data = rest.slice(termIdx + termLen);
  }

  return { displayText, nextCarry: "", commands };
}

function ShellPane({
  tabId,
  containerId,
  kind,
  shell,
  modelName,
  initialSessionId = null,
  dockerHost = null,
  ollamaHost = null,
  activeContainerId,
  visible,
  cwd,
  onSessionExit,
  onSessionIdChange,
  onShellDetected,
  onOpenPathCommand,
  connectRef,
  onPaneReady,
  onPaneGone,
  destroySessionOnUnmount = true,
  terminalTheme = "tokyo-night",
}: ShellPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const keyboardActiveRef = useRef(false);
  const connectGenRef = useRef(0);
  const oscCarryRef = useRef("");
  const pendingInputRef = useRef<string[]>([]);
  const commandLineBufferRef = useRef("");
  const intentionalCloseRef = useRef(false);
  const relayoutAnimationFramesRef = useRef<number[]>([]);
  const relayoutTimeoutsRef = useRef<number[]>([]);
  const initialTerminalThemeRef = useRef(resolveTerminalTheme(terminalTheme));
  const resolvedTerminalTheme = useMemo(
    () => resolveTerminalTheme(terminalTheme),
    [terminalTheme],
  );

  const markIntentionalCloseFromCommand = useCallback((rawCommand: string) => {
    const cmd = rawCommand.trim().toLowerCase();
    intentionalCloseRef.current = cmd === "exit" || cmd === "x";
  }, []);

  const trackOutgoingInput = useCallback(
    (data: string) => {
      // Keep a lightweight approximation of the current command line so we can
      // distinguish expected shell exits (exit/x) from unexpected failures.
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          markIntentionalCloseFromCommand(commandLineBufferRef.current);
          commandLineBufferRef.current = "";
          continue;
        }
        if (ch === "\x7f" || ch === "\b") {
          commandLineBufferRef.current = commandLineBufferRef.current.slice(0, -1);
          continue;
        }
        if (ch === "\x15") {
          commandLineBufferRef.current = "";
          continue;
        }
        if (ch >= " " && ch !== "\x7f") {
          commandLineBufferRef.current += ch;
        }
      }
    },
    [markIntentionalCloseFromCommand],
  );

  const clearScheduledRelayout = useCallback(() => {
    for (const frameId of relayoutAnimationFramesRef.current) {
      cancelAnimationFrame(frameId);
    }
    relayoutAnimationFramesRef.current = [];
    for (const timeoutId of relayoutTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    relayoutTimeoutsRef.current = [];
  }, []);

  const fitAndResizeBackend = useCallback(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    clearScheduledRelayout();

    const applyRelayout = () => {
      const currentTerm = xtermRef.current;
      const currentFitAddon = fitAddonRef.current;
      if (!currentTerm || !currentFitAddon) return;
      try {
        currentFitAddon.fit();
      } catch {
        // ignore
      }
      try {
        currentTerm.refresh(0, Math.max(currentTerm.rows - 1, 0));
      } catch {
        // ignore
      }
      const sid = sessionIdRef.current;
      if (sid) {
        void dockerClient.terminalResize(sid, currentTerm.cols, currentTerm.rows);
      }
    };

    // When panes are shown/hidden via `display: none`, layout can settle a bit later.
    // Re-fit across a couple of frames plus short delays so TUIs redraw at the final size.
    const scheduleAfterFrames = (remainingFrames: number, onReady: () => void) => {
      const frameId = requestAnimationFrame(() => {
        relayoutAnimationFramesRef.current = relayoutAnimationFramesRef.current.filter(
          (id) => id !== frameId,
        );
        if (remainingFrames > 1) {
          scheduleAfterFrames(remainingFrames - 1, onReady);
          return;
        }
        onReady();
      });
      relayoutAnimationFramesRef.current.push(frameId);
    };

    scheduleAfterFrames(2, applyRelayout);
    for (const delayMs of [60, 180]) {
      const timeoutId = window.setTimeout(() => {
        relayoutTimeoutsRef.current = relayoutTimeoutsRef.current.filter(
          (id) => id !== timeoutId,
        );
        scheduleAfterFrames(1, applyRelayout);
      }, delayMs);
      relayoutTimeoutsRef.current.push(timeoutId);
    }
  }, [clearScheduledRelayout]);

  const destroySession = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      sessionIdRef.current = null;
      commandLineBufferRef.current = "";
      intentionalCloseRef.current = false;
      onSessionIdChange(tabId, null);
      try {
        await dockerClient.destroyTerminalSession(sid);
      } catch {
        // ignore
      }
    }
  }, [onSessionIdChange, tabId]);

  const connect = useCallback(async () => {
    const gen = ++connectGenRef.current;
    await destroySession();
    if (gen !== connectGenRef.current) return;

    const term = xtermRef.current;
    if (term) {
      term.clear();
    }
    commandLineBufferRef.current = "";
    intentionalCloseRef.current = false;

    try {
      if (kind === "ollama-run" || kind === "ollama-pull") {
        await ollamaClient.configureOllamaHost(ollamaHost);
      }
      // Best-effort: fit before creating the PTY so it starts at the right size.
      if (visible) {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // ignore
        }
      }
      const cols = term?.cols ?? 80;
      const rows = term?.rows ?? 24;
      if (initialSessionId) {
        try {
          const listed = await dockerClient.listTerminalSessions();
          const canAttach = listed.some((session) => session.sessionId === initialSessionId);
          if (!canAttach) {
            onSessionIdChange(tabId, null);
            throw new Error("Session no longer running");
          }
          const attached = await dockerClient.attachTerminalSession(initialSessionId, cols, rows);
          if (gen !== connectGenRef.current) return;
          sessionIdRef.current = initialSessionId;
          onSessionIdChange(tabId, initialSessionId);
          onShellDetected(tabId, attached.shell);
          if (term && attached.recentOutput) {
            term.write(attached.recentOutput);
          }
          if (visible) fitAndResizeBackend();
          return;
        } catch {
          onSessionIdChange(tabId, null);
          // Session no longer exists; fall through to create a fresh one.
        }
      }
      if (kind === "shell") {
        try {
          await applyBashAliasesToContainer(containerId);
        } catch {
          // ignore alias application failures
        }
      }
      const { sessionId, shell: detectedShell } =
        kind === "local-shell"
          ? await dockerClient.createLocalTerminalSession(modelName, cols, rows)
          : kind === "remote-shell"
            ? await dockerClient.createSshTerminalSession(modelName ?? "", cols, rows)
          : kind === "docker-run"
            ? await ((dockerClient as unknown as {
              createDockerRunTerminalSession?: (
                image: string,
                args: string[],
                cols?: number,
                rows?: number,
                dockerHost?: string | null,
              ) => Promise<{ sessionId: string; shell: string }>;
            }).createDockerRunTerminalSession?.(modelName ?? "", [], cols, rows, dockerHost)
              ?? dockerClient.createModelRunnerTerminalSession(modelName ?? "", cols, rows))
          : kind === "model-run"
          ? await dockerClient.createModelRunnerTerminalSession(modelName ?? "", cols, rows, dockerHost)
          : kind === "ollama-run"
            ? await ollamaClient.createRunTerminalSession(modelName ?? "", cols, rows, ollamaHost)
            : kind === "ollama-pull"
              ? await ollamaClient.createPullTerminalSession(modelName ?? "", cols, rows, ollamaHost)
              : kind === "docker-image-pull"
                ? await dockerClient.createDockerImagePullTerminalSession(modelName ?? "", cols, rows, dockerHost)
                : kind === "docker-model-pull"
                  ? await dockerClient.createDockerModelPullTerminalSession(modelName ?? "", cols, rows, dockerHost)
                  : await dockerClient.createTerminalSession(
                    containerId,
                    shell ?? undefined,
                    cols,
                    rows,
                    cwd ?? undefined,
                    dockerHost,
                  );
      if (gen !== connectGenRef.current) {
        try {
          await dockerClient.destroyTerminalSession(sessionId);
        } catch {
          // ignore
        }
        return;
      }
      sessionIdRef.current = sessionId;
      onSessionIdChange(tabId, sessionId);
      onShellDetected(tabId, detectedShell);
      // Ensure backend PTY matches the actual rendered size.
      if (visible) fitAndResizeBackend();
      const pending = pendingInputRef.current;
      if (pending.length > 0) {
        pendingInputRef.current = [];
        for (const chunk of pending) {
          try {
            await dockerClient.terminalInput(sessionId, chunk);
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      if (gen !== connectGenRef.current) return;
      const msg =
        err instanceof Error ? err.message : "Failed to connect";
      if (term) {
        term.writeln(`\x1b[31mError: ${msg}\x1b[0m`);
      }
    }
  }, [containerId, cwd, destroySession, dockerHost, fitAndResizeBackend, initialSessionId, kind, modelName, ollamaHost, onShellDetected, shell, tabId, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = useCallback(() => {
    keyboardActiveRef.current = true;
    requestAnimationFrame(() => {
      try {
        containerRef.current?.focus({ preventScroll: true });
      } catch {
        // ignore
      }
      try {
        xtermRef.current?.focus();
      } catch {
        // ignore
      }
    });
  }, []);

  const sendText = useCallback((text: string) => {
    trackOutgoingInput(text);
    const sid = sessionIdRef.current;
    if (!sid) {
      pendingInputRef.current.push(text);
      return;
    }
    void dockerClient.terminalInput(sid, text);
  }, [trackOutgoingInput]);

  const sendLine = useCallback(
    (line: string) => {
      const stripped = line.replace(/[\r\n]+$/g, "");
      sendText(stripped + "\r");
    },
    [sendText],
  );

  const copySelectionToClipboard = useCallback(async (): Promise<boolean> => {
    const selection = xtermRef.current?.getSelection()?.toString() ?? "";
    if (!selection) return false;
    try {
      await navigator.clipboard.writeText(selection);
      return true;
    } catch {
      return false;
    }
  }, []);

  const pasteFromClipboard = useCallback(async (): Promise<boolean> => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return false;
      sendText(text);
      return true;
    } catch {
      return false;
    }
  }, [sendText]);

  useEffect(() => {
    onPaneReady(tabId, { focus, sendText, sendLine });
    return () => onPaneGone(tabId);
  }, [focus, onPaneGone, onPaneReady, sendLine, sendText, tabId]);

  // Register connect fn for parent
  useEffect(() => {
    connectRef.current.set(tabId, connect);
    return () => {
      connectRef.current.delete(tabId);
    };
  }, [tabId, connect, connectRef]);

  // Initialize xterm (display-only; keyboard via window listener for WKWebView)
  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return;
    mountedRef.current = true;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: initialTerminalThemeRef.current,
      // PTY sends CRLF already; don't double-convert
      convertEol: false,
      scrollback: 5000,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      fitAndResizeBackend();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearScheduledRelayout();
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      mountedRef.current = false;
    };
  }, [clearScheduledRelayout, fitAndResizeBackend]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = resolvedTerminalTheme;
  }, [resolvedTerminalTheme]);

  // Activate keyboard when visible
  useEffect(() => {
    if (visible) {
      keyboardActiveRef.current = true;
      fitAndResizeBackend();
    } else {
      keyboardActiveRef.current = false;
    }
  }, [visible, fitAndResizeBackend]);

  // Window-level keyboard capture (bypasses WKWebView focus issues)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const root = containerRef.current;
      const active = Boolean(root && root.contains(e.target as Node) && visible);
      keyboardActiveRef.current = active;
      if (active) {
        // Ensure the terminal root becomes the active element so our key handler
        // can reliably determine when the terminal should capture input.
        try {
          root?.focus({ preventScroll: true });
        } catch {
          // ignore
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!visible || !keyboardActiveRef.current) return;
      if (isCodeMirrorFocused()) return;
      const term = xtermRef.current;
      const key = e.key.toLowerCase();

      const isClipboardModifier = (e.metaKey || e.ctrlKey) && !e.altKey;
      const hasSelection = Boolean(term?.hasSelection?.());
      const isCopyShortcut =
        isClipboardModifier
        && key === "c"
        && (!e.shiftKey || hasSelection)
        && hasSelection;
      const isPasteShortcut =
        isClipboardModifier && key === "v";
      if (isCopyShortcut) {
        e.preventDefault();
        void copySelectionToClipboard();
        return;
      }
      if (isPasteShortcut) {
        e.preventDefault();
        void pasteFromClipboard();
        return;
      }
      // Always support local screen clear even when the container image
      // doesn't provide a working `clear` command.
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        term?.clear();
        return;
      }
      const data = keyEventToData(e);
      if (!data) return;
      e.preventDefault();
      sendText(data);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!visible || !keyboardActiveRef.current) return;
      if (isCodeMirrorFocused()) return;
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      e.preventDefault();
      sendText(text);
    };

    const onCopy = (e: ClipboardEvent) => {
      if (!visible || !keyboardActiveRef.current) return;
      if (isCodeMirrorFocused()) return;
      const selection = xtermRef.current?.getSelection()?.toString() ?? "";
      if (!selection) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", selection);
      void navigator.clipboard.writeText(selection).catch(() => { });
    };

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste, true);
    window.addEventListener("copy", onCopy, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("copy", onCopy, true);
    };
  }, [copySelectionToClipboard, pasteFromClipboard, sendText, visible]);

  // Subscribe to terminal output/exit from backend
  useEffect(() => {
    const unsubOutput = onTerminalOutput((sessionId, data) => {
      if (sessionId === sessionIdRef.current && xtermRef.current) {
        const parsed = parseOpenOscCommands(data, oscCarryRef.current);
        oscCarryRef.current = parsed.nextCarry;
        if (parsed.displayText.length > 0) {
          xtermRef.current.write(parsed.displayText);
        }
        if (activeContainerId && activeContainerId === containerId) {
          for (const command of parsed.commands) {
            onOpenPathCommand(containerId, command.path, command.kind);
          }
        }
      }
    });

    const unsubExit = onTerminalExit((sessionId, code) => {
      if (sessionId === sessionIdRef.current) {
        sessionIdRef.current = null;
        onSessionIdChange(tabId, null);
        if (xtermRef.current) {
          xtermRef.current.writeln(
            `\r\n\x1b[33mProcess exited (code ${code}).\x1b[0m`,
          );
        }
        const intentionalClose = intentionalCloseRef.current;
        intentionalCloseRef.current = false;
        commandLineBufferRef.current = "";
        onSessionExit(tabId, code, intentionalClose);
      }
    });

    return () => {
      unsubOutput();
      unsubExit();
    };
  }, [activeContainerId, containerId, onOpenPathCommand, onSessionIdChange, tabId, onSessionExit]);

  // Auto-connect on mount
  useEffect(() => {
    void connect();
    return () => {
      ++connectGenRef.current;
      if (destroySessionOnUnmount) {
        void destroySession();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, destroySessionOnUnmount]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="absolute inset-0 outline-none"
      style={{ display: visible ? "block" : "none" }}
    />
  );
}

export function SingleTerminalPane({
  descriptor,
  activeContainerId,
  containers,
  dockerHost = null,
  ollamaHost = null,
  onOpenPathCommand,
  preferredShellCwdByContainerId,
  onDescriptorSessionIdChange,
  terminalTheme = "tokyo-night",
  visible = true,
}: SingleTerminalPaneProps) {
  const tabIdRef = useRef(`split_terminal_${nextShellTabId()}`);
  const connectFnsRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const paneControlsRef = useRef<Map<string, ShellPaneControl>>(new Map());
  const initialCommandsSentRef = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(
    descriptor.sessionId ?? null,
  );

  const resolvedContainerId = useMemo(() => {
    if (descriptor.kind === "shell") {
      const containerId = descriptor.containerId;
      // When restoring an existing split terminal, keep the persisted container
      // id stable until the container list hydrates. Otherwise we briefly attach
      // with the saved session, then reconnect once the real container appears,
      // which recreates the docker exec session and refreshes full-screen apps.
      if (descriptor.sessionId && containerId) {
        return containerId;
      }
      if (containerId && containers.some((entry) => entry.id === containerId && entry.state === "running")) {
        return containerId;
      }
      return "__missing_container__";
    }
    if (descriptor.kind === "local-shell") return "__local__";
    if (descriptor.kind === "remote-shell") return "__remote__";
    if (descriptor.kind === "ollama-run" || descriptor.kind === "ollama-pull") return "__ollama__";
    if (
      descriptor.kind === "model-run"
      || descriptor.kind === "docker-run"
      || descriptor.kind === "docker-image-pull"
      || descriptor.kind === "docker-model-pull"
    ) {
      return "__docker__";
    }
    return descriptor.containerId ?? "__terminal__";
  }, [containers, descriptor.containerId, descriptor.kind, descriptor.sessionId]);

  const resolvedCwd =
    descriptor.cwd
    ?? (
      descriptor.containerId
        ? preferredShellCwdByContainerId?.[descriptor.containerId]
          ?? containers.find((entry) => entry.id === descriptor.containerId)?.execShellWorkdir?.trim()
          ?? null
        : null
    );

  useEffect(() => {
    if (initialCommandsSentRef.current) return;
    if (!sessionId) return;
    const pending = descriptor.initialCommands ?? [];
    if (pending.length === 0) return;
    const control = paneControlsRef.current.get(tabIdRef.current);
    if (!control) return;
    initialCommandsSentRef.current = true;
    for (const command of pending) {
      control.sendLine(command);
    }
  }, [descriptor.initialCommands, sessionId]);

  return (
    <div
      className="absolute inset-0 min-h-0"
      style={{ display: visible ? "block" : "none" }}
    >
      <ShellPane
        tabId={tabIdRef.current}
        containerId={resolvedContainerId}
        kind={descriptor.kind}
        shell={descriptor.shell ?? undefined}
        modelName={descriptor.modelName ?? undefined}
        initialSessionId={descriptor.sessionId ?? null}
        dockerHost={descriptor.dockerHost ?? dockerHost}
        ollamaHost={descriptor.ollamaHost ?? ollamaHost}
        activeContainerId={activeContainerId}
        visible={visible}
        cwd={resolvedCwd}
        onSessionExit={() => { }}
        onSessionIdChange={(_, nextSessionId) => {
          setSessionId(nextSessionId);
          onDescriptorSessionIdChange?.(nextSessionId);
        }}
        onShellDetected={() => { }}
        onOpenPathCommand={onOpenPathCommand}
        connectRef={connectFnsRef}
        onPaneReady={(paneTabId, control) => {
          paneControlsRef.current.set(paneTabId, control);
        }}
        onPaneGone={(paneTabId) => {
          paneControlsRef.current.delete(paneTabId);
        }}
        destroySessionOnUnmount={false}
        terminalTheme={terminalTheme}
      />
      {!sessionId && descriptor.kind === "shell" && resolvedContainerId === "__missing_container__" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70 p-3 text-xs text-muted-foreground">
          Container is not running, so this terminal cannot reconnect.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContainerTerminal — multi-tab shell manager
// ---------------------------------------------------------------------------

function hashString(input: string): number {
  // Simple, deterministic 32-bit hash.
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const CONTAINER_DOT_COLORS = [
  "bg-emerald-500",
  "bg-blue-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-lime-500",
  "bg-fuchsia-500",
  "bg-orange-500",
  "bg-teal-500",
] as const;
const EMPTY_CONTAINERS: ContainerInfo[] = [];
const EMPTY_REMOTE_ENDPOINTS: RemoteSshEndpoint[] = [];
const EMPTY_PROVIDER_MODELS: ProviderModel[] = [];
const DEFAULT_ENABLED_LOCAL_SHELLS: string[] = ["bash", "zsh"];

function containerDotClass(containerId: string): string {
  const idx = hashString(containerId) % CONTAINER_DOT_COLORS.length;
  return CONTAINER_DOT_COLORS[idx]!;
}

function normalizeNullableString(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function terminalDescriptorsEqual(a: TerminalTabDescriptor, b: TerminalTabDescriptor): boolean {
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId;
  return (
    a.kind === b.kind
    && normalizeNullableString(a.containerId) === normalizeNullableString(b.containerId)
    && normalizeNullableString(a.shell) === normalizeNullableString(b.shell)
    && normalizeNullableString(a.modelName) === normalizeNullableString(b.modelName)
    && normalizeNullableString(a.cwd) === normalizeNullableString(b.cwd)
    && normalizeNullableString(a.dockerHost) === normalizeNullableString(b.dockerHost)
    && normalizeNullableString(a.ollamaHost) === normalizeNullableString(b.ollamaHost)
  );
}

function descriptorMatchesTab(descriptor: TerminalTabDescriptor, tab: ShellTab): boolean {
  if (descriptor.sessionId && tab.sessionId) return descriptor.sessionId === tab.sessionId;
  return (
    descriptor.kind === tab.kind
    && normalizeNullableString(descriptor.containerId) === normalizeNullableString(tab.containerId)
    && normalizeNullableString(descriptor.shell) === normalizeNullableString(tab.shell)
    && normalizeNullableString(descriptor.modelName) === normalizeNullableString(tab.modelName)
    && normalizeNullableString(descriptor.cwd) === normalizeNullableString(tab.cwd)
    && normalizeNullableString(descriptor.dockerHost) === normalizeNullableString(tab.dockerHost)
    && normalizeNullableString(descriptor.ollamaHost) === normalizeNullableString(tab.ollamaHost)
  );
}

export function ContainerTerminal({
  activeContainerId,
  containers,
  dockerLocalContainers = EMPTY_CONTAINERS,
  dockerRemoteContainers = EMPTY_CONTAINERS,
  dockerHost = null,
  ollamaHost = null,
  localTerminalEnabled = true,
  dockerModelEnabled = true,
  ollamaModelEnabled = true,
  dockerLocalEnabled = false,
  dockerRemoteEnabled = false,
  ollamaLocalEnabled = false,
  ollamaRemoteEnabled = false,
  remoteDockerHost = null,
  remoteOllamaHost = null,
  enabledLocalShells = DEFAULT_ENABLED_LOCAL_SHELLS,
  terminalTheme = "tokyo-night",
  remoteEndpoints = EMPTY_REMOTE_ENDPOINTS,
  dockerLocalModels = EMPTY_PROVIDER_MODELS,
  dockerRemoteModels = EMPTY_PROVIDER_MODELS,
  ollamaLocalModels = EMPTY_PROVIDER_MODELS,
  ollamaRemoteModels = EMPTY_PROVIDER_MODELS,
  onOpenPathCommand,
  preferredShellCwdByContainerId,
  panelVisible = true,
  controlRef,
  onActiveSessionReady,
  onTabDragStart,
  onTabDragEnd,
}: Props) {
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const connectFnsRef = useRef<Map<string, () => Promise<void>>>(new Map());
  const paneControlsRef = useRef<Map<string, ShellPaneControl>>(new Map());
  const pendingCommandsRef = useRef<Map<string, string[]>>(new Map());
  const pendingFocusRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef<ShellTab[]>(tabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const sessionIdsRef = useRef<string[]>([]);
  const sessionIdByTabRef = useRef<Map<string, string>>(new Map());
  const containerIdByTabRef = useRef<Map<string, string>>(new Map());
  const pendingRestoreDescriptorsRef = useRef<TerminalTabDescriptor[]>([]);
  const readyNotifiedContainersRef = useRef<Set<string>>(new Set());
  const suppressedAutoOpenContainersRef = useRef<Set<string>>(new Set());
  const hasHydratedPersistedTabsRef = useRef(false);
  // Start in "suppressed" mode so switching containers doesn't auto-open a tab
  // when the user has no terminal tabs open.
  const suppressedAutoOpenWhenNoTabsRef = useRef(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLocalShells, setPickerLocalShells] = useState<string[]>([]);
  const [pickerLocalShellsLoading, setPickerLocalShellsLoading] = useState(false);
  const [pickerLocalShellsError, setPickerLocalShellsError] = useState<string | null>(null);
  const [pickerModels, setPickerModels] = useState<PickerModelInfo[]>([]);
  const [pickerModelsLoading, setPickerModelsLoading] = useState(false);
  const [pickerModelsError, setPickerModelsError] = useState<string | null>(null);
  const [selectedPickerModelTypes, setSelectedPickerModelTypes] = useState<ProviderModelType[]>([]);
  const pickerRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  const runningContainers = useMemo(
    () => containers.filter((c) => c.state === "running"),
    [containers],
  );
  const runningDockerLocalContainers = useMemo(
    () => dockerLocalContainers.filter((c) => c.state === "running"),
    [dockerLocalContainers],
  );
  const runningDockerRemoteContainers = useMemo(
    () => dockerRemoteContainers.filter((c) => c.state === "running"),
    [dockerRemoteContainers],
  );
  const showDockerLocalContainerPickerSection = dockerLocalEnabled;
  const showDockerRemoteContainerPickerSection = dockerRemoteEnabled;
  const showAnyDockerContainerPickerSection =
    showDockerLocalContainerPickerSection || showDockerRemoteContainerPickerSection;
  const showAiModelPickerSection =
    (dockerModelEnabled && dockerLocalEnabled)
    || (dockerModelEnabled && dockerRemoteEnabled)
    || (ollamaModelEnabled && ollamaLocalEnabled)
    || (ollamaModelEnabled && ollamaRemoteEnabled);
  const enabledLocalShellSet = useMemo(
    () =>
      new Set(
        (enabledLocalShells ?? [])
          .map((entry) => {
            const normalized = entry.trim().toLowerCase();
            return normalized.includes("/") ? (normalized.split("/").pop() ?? "") : normalized;
          })
          .filter((entry) => entry.length > 0),
      ),
    [enabledLocalShells],
  );
  const visibleLocalShells = useMemo(() => {
    const seen = new Set<string>();
    return pickerLocalShells.filter((shellPath) => {
      const shellName = shellPath.split("/").pop()?.trim().toLowerCase() ?? "";
      if (shellName.length === 0 || !enabledLocalShellSet.has(shellName)) return false;
      if (seen.has(shellName)) return false;
      seen.add(shellName);
      return true;
    });
  }, [enabledLocalShellSet, pickerLocalShells]);
  const enabledRemoteEndpoints = useMemo(
    () =>
      (remoteEndpoints ?? [])
        .filter((endpoint) => endpoint.enabled && endpoint.host.trim().length > 0)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [remoteEndpoints],
  );
  const configuredPickerModelEntries = useMemo(
    () => {
      const entries: Array<{
        source: "docker" | "ollama";
        environment: "local" | "remote";
        model: ProviderModel;
      }> = [];
      if (dockerModelEnabled && dockerLocalEnabled) {
        entries.push(
          ...dockerLocalModels.map((model) => ({ source: "docker" as const, environment: "local" as const, model })),
        );
      }
      if (dockerModelEnabled && dockerRemoteEnabled) {
        entries.push(
          ...dockerRemoteModels.map((model) => ({ source: "docker" as const, environment: "remote" as const, model })),
        );
      }
      if (ollamaModelEnabled && ollamaLocalEnabled) {
        entries.push(
          ...ollamaLocalModels.map((model) => ({ source: "ollama" as const, environment: "local" as const, model })),
        );
      }
      if (ollamaModelEnabled && ollamaRemoteEnabled) {
        entries.push(
          ...ollamaRemoteModels.map((model) => ({ source: "ollama" as const, environment: "remote" as const, model })),
        );
      }
      return entries;
    },
    [
      dockerLocalEnabled,
      dockerLocalModels,
      dockerModelEnabled,
      dockerRemoteEnabled,
      dockerRemoteModels,
      ollamaLocalEnabled,
      ollamaLocalModels,
      ollamaModelEnabled,
      ollamaRemoteEnabled,
      ollamaRemoteModels,
    ],
  );
  const configuredPickerModelTypes = useMemo(
    () =>
      MODEL_TYPE_LABELS.filter((type) =>
        configuredPickerModelEntries.some((entry) => Boolean(entry.model.enabledTypes[type])),
      ),
    [configuredPickerModelEntries],
  );
  const configuredPickerModelTypesByKey = useMemo(() => {
    const result = new Map<string, ProviderModelType[]>();
    for (const entry of configuredPickerModelEntries) {
      const modelId = entry.model.id.trim();
      if (!modelId) continue;
      result.set(
        pickerConfiguredModelKey(entry.source, entry.environment, modelId),
        MODEL_TYPE_LABELS.filter((type) => Boolean(entry.model.enabledTypes[type])),
      );
    }
    return result;
  }, [configuredPickerModelEntries]);
  const visiblePickerModels = useMemo(
    () =>
      pickerModels.filter((model) => {
        if (selectedPickerModelTypes.length === 0) return true;
        const modelTypes =
          configuredPickerModelTypesByKey.get(
            pickerConfiguredModelKey(model.source, model.environment, model.name),
          ) ?? [];
        return modelTypes.some((type) => selectedPickerModelTypes.includes(type));
      }),
    [configuredPickerModelTypesByKey, pickerModels, selectedPickerModelTypes],
  );

  useEffect(() => {
    setSelectedPickerModelTypes((prev) => {
      const next = prev.filter((type) => configuredPickerModelTypes.includes(type));
      if (next.length === prev.length && next.every((type, idx) => type === prev[idx])) {
        return prev;
      }
      return next;
    });
  }, [configuredPickerModelTypes]);

  // Session lifetime is explicit: closing tabs destroys sessions.
  // We intentionally do not destroy on page unload so daemon-backed sessions
  // survive refreshes and app restarts.

  // Close picker when clicking outside
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const root = pickerRootRef.current;
      if (!root) return;
      if (root.contains(e.target as Node)) return;
      setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [pickerOpen]);

  // Load local shells + AI models when the "+" picker opens so the lists are fresh.
  useEffect(() => {
    if (!pickerOpen) return;
    let active = true;
    if (localTerminalEnabled) {
      setPickerLocalShellsLoading(true);
      setPickerLocalShellsError(null);
    } else {
      setPickerLocalShells([]);
      setPickerLocalShellsLoading(false);
      setPickerLocalShellsError(null);
    }
    if (showAiModelPickerSection) {
      setPickerModelsLoading(true);
      setPickerModelsError(null);
    } else {
      setPickerModels([]);
      setPickerModelsLoading(false);
      setPickerModelsError(null);
    }
    const settle = async <T,>(work: () => Promise<T>): Promise<PromiseSettledResult<T>> => {
      try {
        return { status: "fulfilled", value: await work() };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    };
    const loadDockerModelsForHost = async (targetHost: string | null) => {
      return await dockerClient.runWithDockerHost(targetHost, async () => await dockerClient.listAiModels());
    };
    const loadOllamaModelsForHost = async (targetHost: string | null) => {
      await ollamaClient.configureOllamaHost(targetHost);
      return await ollamaClient.listModels();
    };
    void (async () => {
      const shellsPromise = settle(() =>
        localTerminalEnabled ? dockerClient.listLocalShells() : Promise.resolve([] as string[]),
      );
      // Host configuration is global for each client; fetch per-host sequentially
      // to avoid cross-host races in the picker.
      const dockerLocalRes = dockerModelEnabled && dockerLocalEnabled
        ? await settle(() => loadDockerModelsForHost(null))
        : ({ status: "fulfilled", value: [] as AIModelInfo[] } satisfies PromiseFulfilledResult<AIModelInfo[]>);
      const dockerRemoteRes = dockerModelEnabled && dockerRemoteEnabled
        ? await settle(() => loadDockerModelsForHost(remoteDockerHost))
        : ({ status: "fulfilled", value: [] as AIModelInfo[] } satisfies PromiseFulfilledResult<AIModelInfo[]>);
      const ollamaLocalRes = ollamaModelEnabled && ollamaLocalEnabled
        ? await settle(() => loadOllamaModelsForHost(null))
        : ({ status: "fulfilled", value: [] as OllamaModelInfo[] } satisfies PromiseFulfilledResult<OllamaModelInfo[]>);
      const ollamaRemoteRes = ollamaModelEnabled && ollamaRemoteEnabled
        ? await settle(() => loadOllamaModelsForHost(remoteOllamaHost))
        : ({ status: "fulfilled", value: [] as OllamaModelInfo[] } satisfies PromiseFulfilledResult<OllamaModelInfo[]>);
      const shellsRes = await shellsPromise;
      return { shellsRes, dockerLocalRes, dockerRemoteRes, ollamaLocalRes, ollamaRemoteRes };
    })()
      .then(({ shellsRes, dockerLocalRes, dockerRemoteRes, ollamaLocalRes, ollamaRemoteRes }) => {
        if (!active) return;
        if (shellsRes.status === "fulfilled") {
          setPickerLocalShells(shellsRes.value);
          setPickerLocalShellsError(null);
        } else {
          const msg = shellsRes.reason instanceof Error ? shellsRes.reason.message : "Failed to load local shells";
          setPickerLocalShells([]);
          setPickerLocalShellsError(msg);
        }
        if (!showAiModelPickerSection) {
          setPickerModels([]);
          setPickerModelsError(null);
          return;
        }
        const models: PickerModelInfo[] = [];
        if (dockerModelEnabled && dockerLocalEnabled && dockerLocalRes.status === "fulfilled") {
          models.push(...dockerLocalRes.value.map((model) => ({
            id: model.id || model.name,
            name: model.name,
            size: model.size || "",
            source: "docker" as const,
            environment: "local" as const,
            host: null,
            sourceLabel: "docker local",
          })));
        }
        if (dockerModelEnabled && dockerRemoteEnabled && dockerRemoteRes.status === "fulfilled") {
          models.push(...dockerRemoteRes.value.map((model) => ({
            id: model.id || model.name,
            name: model.name,
            size: model.size || "",
            source: "docker" as const,
            environment: "remote" as const,
            host: remoteDockerHost,
            sourceLabel: "docker remote",
          })));
        }
        if (ollamaModelEnabled && ollamaLocalEnabled && ollamaLocalRes.status === "fulfilled") {
          models.push(...ollamaLocalRes.value.map((model) => ({
            id: model.id || model.name,
            name: model.name,
            size: model.size || "",
            source: "ollama" as const,
            environment: "local" as const,
            host: null,
            sourceLabel: "ollama local",
          })));
        }
        if (ollamaModelEnabled && ollamaRemoteEnabled && ollamaRemoteRes.status === "fulfilled") {
          models.push(...ollamaRemoteRes.value.map((model) => ({
            id: model.id || model.name,
            name: model.name,
            size: model.size || "",
            source: "ollama" as const,
            environment: "remote" as const,
            host: remoteOllamaHost,
            sourceLabel: "ollama remote",
          })));
        }
        models.sort((a, b) => {
          if (a.source !== b.source) return a.source.localeCompare(b.source);
          if (a.environment !== b.environment) return a.environment.localeCompare(b.environment);
          return a.name.localeCompare(b.name);
        });
        setPickerModels(models);
        const modelErrors: string[] = [];
        if (dockerModelEnabled && dockerLocalEnabled && dockerLocalRes.status === "rejected") {
          modelErrors.push(
            `Docker local: ${
              dockerLocalRes.reason instanceof Error ? dockerLocalRes.reason.message : "models failed"
            }`,
          );
        }
        if (dockerModelEnabled && dockerRemoteEnabled && dockerRemoteRes.status === "rejected") {
          modelErrors.push(
            `Docker remote: ${
              dockerRemoteRes.reason instanceof Error ? dockerRemoteRes.reason.message : "models failed"
            }`,
          );
        }
        if (ollamaModelEnabled && ollamaLocalEnabled && ollamaLocalRes.status === "rejected") {
          modelErrors.push(
            `Ollama local: ${
              ollamaLocalRes.reason instanceof Error ? ollamaLocalRes.reason.message : "models failed"
            }`,
          );
        }
        if (ollamaModelEnabled && ollamaRemoteEnabled && ollamaRemoteRes.status === "rejected") {
          modelErrors.push(
            `Ollama remote: ${
              ollamaRemoteRes.reason instanceof Error ? ollamaRemoteRes.reason.message : "models failed"
            }`,
          );
        }
        setPickerModelsError(modelErrors.length > 0 ? modelErrors.join("; ") : null);
      })
      .catch((err) => {
        if (!active) return;
        const localMsg = err instanceof Error ? err.message : "Failed to load local shells";
        setPickerLocalShellsError(localMsg);
        setPickerLocalShells([]);
        const msg = err instanceof Error ? err.message : "Failed to load AI models";
        setPickerModelsError(msg);
        setPickerModels([]);
      })
      .finally(() => {
        if (!active) return;
        setPickerLocalShellsLoading(false);
        setPickerModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    dockerLocalEnabled,
    dockerModelEnabled,
    dockerRemoteEnabled,
    localTerminalEnabled,
    ollamaLocalEnabled,
    ollamaModelEnabled,
    ollamaRemoteEnabled,
    pickerOpen,
    remoteDockerHost,
    remoteOllamaHost,
    showAiModelPickerSection,
  ]);

  const onPaneReady = useCallback((tabId: string, control: ShellPaneControl) => {
    paneControlsRef.current.set(tabId, control);
    const pending = pendingCommandsRef.current.get(tabId);
    if (pending && pending.length > 0) {
      for (const cmd of pending) control.sendLine(cmd);
      pendingCommandsRef.current.delete(tabId);
    }
    if (pendingFocusRef.current.has(tabId)) {
      pendingFocusRef.current.delete(tabId);
      control.focus();
    }
  }, []);

  const onPaneGone = useCallback((tabId: string) => {
    paneControlsRef.current.delete(tabId);
    pendingCommandsRef.current.delete(tabId);
    pendingFocusRef.current.delete(tabId);
  }, []);

  const onSessionIdChange = useCallback((tabId: string, sessionId: string | null) => {
    if (sessionId) {
      sessionIdByTabRef.current.set(tabId, sessionId);
    } else {
      sessionIdByTabRef.current.delete(tabId);
    }
    sessionIdsRef.current = Array.from(sessionIdByTabRef.current.values());
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, sessionId } : t)));

    if (
      sessionId &&
      onActiveSessionReady &&
      activeContainerId &&
      containerIdByTabRef.current.get(tabId) === activeContainerId &&
      !readyNotifiedContainersRef.current.has(activeContainerId)
    ) {
      readyNotifiedContainersRef.current.add(activeContainerId);
      onActiveSessionReady(activeContainerId);
    }
  }, [activeContainerId, onActiveSessionReady]);

  const addTabForContainer = useCallback(
    (
      container: ContainerInfo,
      initialCommands?: string[],
      opts?: {
        auto?: boolean;
        sessionId?: string | null;
        dockerHost?: string | null;
        shell?: string | null;
        label?: string | null;
        fixedLabel?: boolean;
      },
    ) => {
      const containerId = container.id;
      const containerName = container.name || containerId.slice(0, 12);
      const id = nextShellTabId();
      const cwd = preferredShellCwdByContainerId?.[containerId] ?? container.execShellWorkdir?.trim() ?? null;
      const preferredShell = getPrimaryContainerShell(container);
      const shell = opts?.shell ?? preferredShell?.command ?? null;
      const label = opts?.label ?? preferredShell?.name ?? "shell";
      const fixedLabel = opts?.fixedLabel ?? Boolean(preferredShell);
      if (!opts?.auto) {
        suppressedAutoOpenContainersRef.current.delete(containerId);
        suppressedAutoOpenWhenNoTabsRef.current = false;
      }
      containerIdByTabRef.current.set(id, containerId);
      setTabs((prev) => [
        ...prev,
        {
          id,
          label,
          containerId,
          containerName,
          kind: "shell",
          shell,
          fixedLabel,
          sessionId: opts?.sessionId ?? null,
          connecting: false,
          exited: false,
          cwd,
          dockerHost: opts?.dockerHost ?? null,
          ollamaHost: null,
        },
      ]);
      setActiveTabId(id);
      if (initialCommands && initialCommands.length > 0) {
        pendingCommandsRef.current.set(id, [...initialCommands]);
      }
      pendingFocusRef.current.add(id);
      return id;
    },
    [preferredShellCwdByContainerId],
  );

  const addModelRunTab = useCallback(
    (modelName: string, sessionId?: string | null, dockerHostOverride?: string | null) => {
      if (!dockerModelEnabled) return null;
      const trimmed = modelName.trim();
      if (!trimmed) return null;
      const preferredContainer =
        (activeContainerId ? runningContainers.find((c) => c.id === activeContainerId) : undefined)
        ?? runningContainers[0]
        ?? null;
      const containerId = preferredContainer?.id ?? "__model-run__";
      const containerName = preferredContainer?.name || "docker";
      const id = nextShellTabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          label: formatModelTabLabel(trimmed),
          containerId,
          containerName,
          kind: "model-run",
          modelName: trimmed,
          sessionId: sessionId ?? null,
          connecting: false,
          exited: false,
          cwd: null,
          dockerHost: dockerHostOverride ?? dockerHost,
          ollamaHost: null,
        },
      ]);
      setActiveTabId(id);
      pendingFocusRef.current.add(id);
      return id;
    },
    [activeContainerId, dockerHost, dockerModelEnabled, runningContainers],
  );

  const addLocalShellTab = useCallback((shellPath: string, sessionId?: string | null) => {
    if (!localTerminalEnabled) return null;
    const trimmed = shellPath.trim();
    if (!trimmed) return null;
    const id = nextShellTabId();
    const shellName = trimmed.split("/").pop() || "sh";
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: shellName,
        containerId: "__local__",
        containerName: "local",
        kind: "local-shell",
        modelName: trimmed,
        fixedLabel: true,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: null,
        ollamaHost: null,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, [localTerminalEnabled]);

  const addRemoteShellTab = useCallback((name: string, host: string, sessionId?: string | null) => {
    const trimmedHost = host.trim();
    if (!trimmedHost) return null;
    const id = nextShellTabId();
    const trimmedName = name.trim();
    const displayName = trimmedName || trimmedHost;
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: displayName,
        containerId: "__remote__",
        containerName: "remote",
        kind: "remote-shell",
        modelName: trimmedHost,
        fixedLabel: true,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: null,
        ollamaHost: null,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, []);

  const addDockerRunTab = useCallback((imageName: string, sessionId?: string | null, dockerHostOverride?: string | null) => {
    const trimmed = imageName.trim();
    if (!trimmed) return null;
    const id = nextShellTabId();
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: `run: ${trimmed.split(":")[0] ?? trimmed}`,
        containerId: "__docker-run__",
        containerName: "docker",
        kind: "docker-run",
        modelName: trimmed,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: dockerHostOverride ?? dockerHost,
        ollamaHost: null,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, [dockerHost]);

  const addOllamaRunTab = useCallback((modelName: string, sessionId?: string | null, ollamaHostOverride?: string | null) => {
    if (!ollamaModelEnabled) return null;
    const trimmed = modelName.trim();
    if (!trimmed) return null;
    const id = nextShellTabId();
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: trimmed.split(":")[0] ?? trimmed,
        containerId: "__ollama__",
        containerName: "ollama",
        kind: "ollama-run" as const,
        modelName: trimmed,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: null,
        ollamaHost: ollamaHostOverride ?? ollamaHost,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, [ollamaHost, ollamaModelEnabled]);

  const addOllamaPullTab = useCallback((modelName: string, sessionId?: string | null, ollamaHostOverride?: string | null) => {
    if (!ollamaModelEnabled) return null;
    const trimmed = modelName.trim();
    if (!trimmed) return null;
    const id = nextShellTabId();
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: `pull: ${trimmed.split(":")[0] ?? trimmed}`,
        containerId: "__ollama__",
        containerName: "ollama",
        kind: "ollama-pull" as const,
        modelName: trimmed,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: null,
        ollamaHost: ollamaHostOverride ?? ollamaHost,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, [ollamaHost, ollamaModelEnabled]);

  const addDockerImagePullTab = useCallback((imageName: string, sessionId?: string | null, dockerHostOverride?: string | null) => {
    const trimmed = imageName.trim();
    if (!trimmed) return null;
    const id = nextShellTabId();
    const label = trimmed.split(":")[0] ?? trimmed;
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: `pull: ${label}`,
        containerId: "__docker-pull__",
        containerName: "docker",
        kind: "docker-image-pull" as const,
        modelName: trimmed,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: dockerHostOverride ?? dockerHost,
        ollamaHost: null,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, [dockerHost]);

  const addDockerModelPullTab = useCallback((modelName: string, sessionId?: string | null, dockerHostOverride?: string | null) => {
    const trimmed = modelName.trim();
    if (!trimmed) return null;
    const id = nextShellTabId();
    const label = trimmed.split(":")[0] ?? trimmed;
    setTabs((prev) => [
      ...prev,
      {
        id,
        label: `pull: ${label}`,
        containerId: "__docker-pull__",
        containerName: "docker",
        kind: "docker-model-pull" as const,
        modelName: trimmed,
        sessionId: sessionId ?? null,
        connecting: false,
        exited: false,
        cwd: null,
        dockerHost: dockerHostOverride ?? dockerHost,
        ollamaHost: null,
      },
    ]);
    setActiveTabId(id);
    pendingFocusRef.current.add(id);
    return id;
  }, [dockerHost]);

  const addTab = useCallback(() => {
    // UI "+" uses picker; programmatic adds should use controlRef APIs.
    setPickerOpen((v) => !v);
  }, []);

  const onShellDetected = useCallback((tabId: string, shell: string) => {
    const name = shell.split("/").pop() || "sh";
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        if (
          t.fixedLabel ||
          t.kind === "remote-shell" ||
          t.kind === "docker-run" ||
          t.kind === "model-run" ||
          t.kind === "ollama-run" ||
          t.kind === "ollama-pull" ||
          t.kind === "docker-image-pull" ||
          t.kind === "docker-model-pull"
        ) return t;
        return { ...t, label: name };
      }),
    );
  }, []);

  const closeTab = useCallback(
    (tabId: string, opts?: { auto?: boolean; preserveSession?: boolean }) => {
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId);
        if (tab?.sessionId) {
          sessionIdByTabRef.current.delete(tabId);
          sessionIdsRef.current = Array.from(sessionIdByTabRef.current.values());
          if (!opts?.preserveSession) {
            void dockerClient.destroyTerminalSession(tab.sessionId).catch(() => { });
          }
        }
        const containerId = containerIdByTabRef.current.get(tabId);
        if (containerId) {
          containerIdByTabRef.current.delete(tabId);
          const anyLeft = Array.from(containerIdByTabRef.current.values()).some((id) => id === containerId);
          if (tab?.kind === "shell" && !anyLeft) readyNotifiedContainersRef.current.delete(containerId);
          if (tab?.kind === "shell" && !anyLeft && !opts?.auto) {
            suppressedAutoOpenContainersRef.current.add(containerId);
          }
        }
        const next = prev.filter((t) => t.id !== tabId);
        if (next.length === 0 && !opts?.auto) {
          suppressedAutoOpenWhenNoTabsRef.current = true;
        }
        if (activeTabId === tabId) {
          const newActive =
            next.length > 0 ? next[next.length - 1]!.id : null;
          setTimeout(() => setActiveTabId(newActive), 0);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const getTabDescriptor = useCallback((tabId: string): TerminalTabDescriptor | null => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    if (!tab) return null;
    return {
      kind: tab.kind,
      containerId: tab.containerId ?? null,
      containerName: tab.containerName ?? null,
      label: tab.label ?? null,
      shell: tab.shell ?? null,
      fixedLabel: Boolean(tab.fixedLabel),
      modelName: tab.modelName ?? null,
      cwd: tab.cwd ?? null,
      sessionId: tab.sessionId ?? null,
      dockerHost: tab.dockerHost ?? null,
      ollamaHost: tab.ollamaHost ?? null,
    };
  }, []);

  const openTabFromDescriptor = useCallback(
    (descriptor: TerminalTabDescriptor): string | null => {
      switch (descriptor.kind) {
        case "shell": {
          const containerId = descriptor.containerId;
          if (!containerId) return null;
          const container = runningContainers.find((entry) => entry.id === containerId);
          if (!container) return null;
          const preferredShell = getPrimaryContainerShell(container);
          return addTabForContainer(container, undefined, {
            sessionId: descriptor.sessionId ?? null,
            dockerHost: descriptor.dockerHost ?? null,
            shell: descriptor.shell ?? preferredShell?.command ?? null,
            label: descriptor.label ?? preferredShell?.name ?? "shell",
            fixedLabel: descriptor.fixedLabel ?? Boolean(preferredShell),
          });
        }
        case "local-shell":
          return descriptor.modelName
            ? addLocalShellTab(descriptor.modelName, descriptor.sessionId ?? null)
            : null;
        case "remote-shell":
          return descriptor.modelName
            ? addRemoteShellTab("", descriptor.modelName, descriptor.sessionId ?? null)
            : null;
        case "docker-run":
          return descriptor.modelName
            ? addDockerRunTab(
              descriptor.modelName,
              descriptor.sessionId ?? null,
              descriptor.dockerHost ?? dockerHost,
            )
            : null;
        case "model-run":
          return descriptor.modelName
            ? addModelRunTab(
              descriptor.modelName,
              descriptor.sessionId ?? null,
              descriptor.dockerHost ?? dockerHost,
            )
            : null;
        case "ollama-run":
          return descriptor.modelName
            ? addOllamaRunTab(
              descriptor.modelName,
              descriptor.sessionId ?? null,
              descriptor.ollamaHost ?? ollamaHost,
            )
            : null;
        case "ollama-pull":
          return descriptor.modelName
            ? addOllamaPullTab(
              descriptor.modelName,
              descriptor.sessionId ?? null,
              descriptor.ollamaHost ?? ollamaHost,
            )
            : null;
        case "docker-image-pull":
          return descriptor.modelName
            ? addDockerImagePullTab(
              descriptor.modelName,
              descriptor.sessionId ?? null,
              descriptor.dockerHost ?? dockerHost,
            )
            : null;
        case "docker-model-pull":
          return descriptor.modelName
            ? addDockerModelPullTab(
              descriptor.modelName,
              descriptor.sessionId ?? null,
              descriptor.dockerHost ?? dockerHost,
            )
            : null;
        default:
          return null;
      }
    },
    [
      addDockerRunTab,
      addDockerImagePullTab,
      addDockerModelPullTab,
      addLocalShellTab,
      addModelRunTab,
      addOllamaPullTab,
      addOllamaRunTab,
      addRemoteShellTab,
      addTabForContainer,
      dockerHost,
      ollamaHost,
      runningContainers,
    ],
  );

  useEffect(() => {
    if (hasHydratedPersistedTabsRef.current) return;
    hasHydratedPersistedTabsRef.current = true;
    const persisted = readJSON<{
      tabs?: TerminalTabDescriptor[];
      activeSessionId?: string | null;
    }>(TERMINAL_TABS_STORAGE_KEY);
    pendingRestoreDescriptorsRef.current = Array.isArray(persisted?.tabs) ? [...persisted.tabs] : [];
    if (persisted?.activeSessionId) {
      setTimeout(() => {
        const preferred = tabsRef.current.find((tab) => tab.sessionId === persisted.activeSessionId);
        if (preferred) setActiveTabId(preferred.id);
      }, 0);
    }
  }, []);

  const restorePendingDescriptors = useCallback(() => {
    const pending = pendingRestoreDescriptorsRef.current;
    if (pending.length === 0) return;
    const remaining: TerminalTabDescriptor[] = [];
    let changed = false;
    for (const descriptor of pending) {
      const alreadyOpen = tabsRef.current.some((tab) => descriptorMatchesTab(descriptor, tab));
      if (alreadyOpen) {
        changed = true;
        continue;
      }
      const opened = openTabFromDescriptor(descriptor);
      if (opened) {
        changed = true;
        continue;
      }
      remaining.push(descriptor);
    }
    if (changed || remaining.length !== pending.length) {
      pendingRestoreDescriptorsRef.current = remaining;
    }
  }, [openTabFromDescriptor]);

  useEffect(() => {
    if (!hasHydratedPersistedTabsRef.current) return;
    restorePendingDescriptors();
  }, [restorePendingDescriptors]);

  useEffect(() => {
    if (!hasHydratedPersistedTabsRef.current) return;
    const openDescriptors: TerminalTabDescriptor[] = tabs.map((tab) => ({
      kind: tab.kind,
      containerId: tab.containerId ?? null,
      containerName: tab.containerName ?? null,
      label: tab.label ?? null,
      shell: tab.shell ?? null,
      fixedLabel: Boolean(tab.fixedLabel),
      modelName: tab.modelName ?? null,
      cwd: tab.cwd ?? null,
      sessionId: tab.sessionId ?? null,
      dockerHost: tab.dockerHost ?? null,
      ollamaHost: tab.ollamaHost ?? null,
    }));
    const pendingDescriptors = pendingRestoreDescriptorsRef.current.filter((pendingDescriptor) =>
      !openDescriptors.some((openDescriptor) => terminalDescriptorsEqual(openDescriptor, pendingDescriptor))
    );
    const payload = {
      tabs: [...openDescriptors, ...pendingDescriptors],
      activeSessionId:
        tabs.find((tab) => tab.id === activeTabId)?.sessionId
        ?? tabs[0]?.sessionId
        ?? null,
    };
    writeJSON(TERMINAL_TABS_STORAGE_KEY, payload);
  }, [activeTabId, tabs]);

  // Update container display names as the container list changes.
  useEffect(() => {
    const nameById = new Map(containers.map((c) => [c.id, c.name || c.id.slice(0, 12)]));
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        const nextName = nameById.get(t.containerId);
        if (nextName && nextName !== t.containerName) {
          changed = true;
          return { ...t, containerName: nextName };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [containers]);

  // Auto-close tabs whose containers are no longer running/present.
  useEffect(() => {
    const runningIds = new Set(runningContainers.map((c) => c.id));
    const stale = tabsRef.current.filter((t) => t.kind === "shell" && !runningIds.has(t.containerId));
    if (stale.length === 0) return;
    for (const tab of stale) closeTab(tab.id, { auto: true });
  }, [runningContainers, closeTab]);

  // Terminal tabs are globally managed and restored from persistence.
  // Do not auto-switch or auto-create tabs when active container context changes.

  useEffect(() => {
    if (!controlRef) return;
    const resolveDockerHostForContainerId = (containerId: string | null | undefined): string | null => {
      if (!containerId) return null;
      if (dockerLocalContainers.some((container) => container.id === containerId)) return null;
      if (dockerRemoteContainers.some((container) => container.id === containerId)) return remoteDockerHost;
      return null;
    };
    const api: ContainerTerminalControl = {
      focusActive: () => {
        const id = activeTabIdRef.current ?? tabsRef.current[0]?.id ?? null;
        if (!id) return;
        const control = paneControlsRef.current.get(id);
        if (control) control.focus();
        else pendingFocusRef.current.add(id);
      },
      focusTab: (tabId: string) => {
        setActiveTabId(tabId);
        const control = paneControlsRef.current.get(tabId);
        if (control) control.focus();
        else pendingFocusRef.current.add(tabId);
      },
      addTab: () => {
        if (!activeContainerId) return null;
        const container = runningContainers.find((c) => c.id === activeContainerId);
        if (!container) return null;
        const id = addTabForContainer(container, undefined, {
          dockerHost: resolveDockerHostForContainerId(activeContainerId),
        });
        pendingFocusRef.current.add(id);
        return id;
      },
      openContainerInNewTab: (containerId: string) => {
        const container = runningContainers.find((c) => c.id === containerId);
        if (!container) return null;
        const id = addTabForContainer(container, undefined, {
          dockerHost: resolveDockerHostForContainerId(containerId),
        });
        pendingFocusRef.current.add(id);
        return id;
      },
      runCommandInNewTab: (command: string) => {
        if (!activeContainerId) return null;
        const container = runningContainers.find((c) => c.id === activeContainerId);
        if (!container) return null;
        const id = addTabForContainer(container, [command], {
          dockerHost: resolveDockerHostForContainerId(activeContainerId),
        });
        pendingFocusRef.current.add(id);
        return id;
      },
      runModelInNewTab: (modelName: string, nextDockerHost?: string | null) => {
        return addModelRunTab(modelName, undefined, nextDockerHost ?? dockerHost);
      },
      runOllamaModelInNewTab: (modelName: string, nextOllamaHost?: string | null) => {
        return addOllamaRunTab(modelName, undefined, nextOllamaHost ?? ollamaHost);
      },
      pullOllamaModelInNewTab: (modelName: string, nextOllamaHost?: string | null) => {
        return addOllamaPullTab(modelName, undefined, nextOllamaHost ?? ollamaHost);
      },
      pullDockerImageInNewTab: (imageName: string, nextDockerHost?: string | null) => {
        return addDockerImagePullTab(imageName, undefined, nextDockerHost ?? dockerHost);
      },
      pullDockerModelInNewTab: (modelName: string, nextDockerHost?: string | null) => {
        return addDockerModelPullTab(modelName, undefined, nextDockerHost ?? dockerHost);
      },
      closeTab: (tabId: string, opts?: { preserveSession?: boolean }) => {
        closeTab(tabId, { preserveSession: opts?.preserveSession });
      },
      getTabDescriptor: (tabId: string) => getTabDescriptor(tabId),
      openTabFromDescriptor: (descriptor: TerminalTabDescriptor) => openTabFromDescriptor(descriptor),
    };
    controlRef.current = api;
    return () => {
      if (controlRef.current === api) controlRef.current = null;
    };
  }, [
    activeContainerId,
    addModelRunTab,
    addOllamaRunTab,
    addOllamaPullTab,
    addDockerImagePullTab,
    addDockerModelPullTab,
    dockerHost,
    dockerLocalContainers,
    dockerRemoteContainers,
    ollamaHost,
    addTabForContainer,
    closeTab,
    controlRef,
    getTabDescriptor,
    openTabFromDescriptor,
    remoteDockerHost,
    runningContainers,
  ]);

  const onSessionExit = useCallback(
    (tabId: string, exitCode: number, intentionalClose: boolean) => {
      if (exitCode === 0 || (exitCode === 127 && intentionalClose)) {
        closeTab(tabId);
      }
    },
    [closeTab],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Shell tab bar */}
      <div
        ref={pickerRootRef}
        className="relative flex items-center bg-background shrink-0 overflow-x-auto"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={[
              "group flex items-center gap-1 px-2 py-1 text-xs cursor-pointer border-r border-border shrink-0",
              onTabDragStart ? "cursor-grab" : "",
              activeTabId === tab.id
                ? "bg-muted/60 text-foreground"
                : "text-muted-foreground hover:bg-muted/30",
            ].join(" ")}
            onClick={() => setActiveTabId(tab.id)}
            draggable={Boolean(onTabDragStart)}
            onDragStart={(event) => {
              if (!onTabDragStart) return;
              const fallbackPayload = JSON.stringify({
                tabId: tab.id,
                kind: tab.kind,
                containerId: tab.containerId ?? null,
                modelName: tab.modelName ?? null,
              });
              // WebKit drag/drop is more reliable when text/plain is present.
              event.dataTransfer.setData("text/plain", fallbackPayload);
              onTabDragStart(
                {
                  tabId: tab.id,
                  descriptor: {
                    kind: tab.kind,
                    containerId: tab.containerId ?? null,
                    containerName: tab.containerName ?? null,
                    label: tab.label ?? null,
                    shell: tab.shell ?? null,
                    fixedLabel: Boolean(tab.fixedLabel),
                    modelName: tab.modelName ?? null,
                    cwd: tab.cwd ?? null,
                    sessionId: tab.sessionId ?? null,
                    dockerHost: tab.dockerHost ?? null,
                    ollamaHost: tab.ollamaHost ?? null,
                  },
                },
                event,
              );
            }}
            onDragEnd={onTabDragEnd}
          >
            <span className={["h-2 w-2 rounded-full shrink-0", containerDotClass(tab.containerId)].join(" ")} />
            <span className="truncate max-w-48">
              {tab.label} <span className="opacity-70">·</span> {tab.containerName}
            </span>
            <button
              type="button"
              className="ml-1 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/80 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              title="Close shell"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="relative shrink-0">
          <button
            type="button"
            title="New shell"
            aria-haspopup="menu"
            aria-expanded={pickerOpen}
            className="inline-flex items-center justify-center px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer"
            onClick={addTab}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {pickerOpen && (
            <div
              role="menu"
              className="fixed z-50 w-80 rounded-md border border-border bg-background shadow-lg overflow-hidden"
            >
              {localTerminalEnabled ? (
                <>
                  <div className="px-2 py-1 text-[11px] text-muted-foreground border-b border-border">
                    Local
                  </div>
                  {pickerLocalShellsLoading ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground border-b border-border">Loading local shells...</div>
                  ) : pickerLocalShellsError ? (
                    <div className="px-2 py-2 text-xs text-destructive border-b border-border">{pickerLocalShellsError}</div>
                  ) : visibleLocalShells.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground border-b border-border">No enabled local shells.</div>
                  ) : (
                    <div className="max-h-32 overflow-auto border-b border-border">
                      {visibleLocalShells.map((shellPath) => {
                        const shellName = shellPath.split("/").pop() || shellPath;
                        return (
                          <button
                            key={shellPath}
                            type="button"
                            className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40 cursor-pointer"
                            onClick={() => {
                              setPickerOpen(false);
                              addLocalShellTab(shellPath);
                            }}
                            role="menuitem"
                          >
                            <span className="h-2 w-2 rounded-full shrink-0 bg-emerald-500" />
                            <span className="truncate flex-1">{shellName}</span>
                            <span className="text-[11px] text-muted-foreground shrink-0">local</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : null}
              {enabledRemoteEndpoints.length > 0 ? (
                <>
                  <div className="px-2 py-1 text-[11px] text-muted-foreground border-b border-border">
                    Remote
                  </div>
                  <div className="max-h-32 overflow-auto border-b border-border">
                    {enabledRemoteEndpoints.map((endpoint) => (
                      <button
                        key={endpoint.id}
                        type="button"
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40 cursor-pointer"
                        onClick={() => {
                          setPickerOpen(false);
                          addRemoteShellTab(endpoint.name, endpoint.host);
                        }}
                        role="menuitem"
                      >
                        <span className="h-2 w-2 rounded-full shrink-0 bg-indigo-500" />
                        <span className="truncate flex-1">{endpoint.name}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0">ssh</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {showAnyDockerContainerPickerSection ? (
                <>
                  {showDockerLocalContainerPickerSection ? (
                    <>
                      <div className="px-2 py-1 text-[11px] text-muted-foreground border-b border-border">
                        Docker Local
                      </div>
                      {runningDockerLocalContainers.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-muted-foreground border-b border-border">
                          No running local containers.
                        </div>
                      ) : (
                        <div className="max-h-32 overflow-auto border-b border-border">
                          {runningDockerLocalContainers.map((c) => (
                            <button
                              key={`local:${c.id}`}
                              type="button"
                              className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40 cursor-pointer"
                              onClick={() => {
                                setPickerOpen(false);
                                addTabForContainer(c, undefined, { dockerHost: null });
                              }}
                              role="menuitem"
                            >
                              <span className={["h-2 w-2 rounded-full shrink-0", containerDotClass(c.id)].join(" ")} />
                              <span className="truncate flex-1">{c.name || c.id.slice(0, 12)}</span>
                              <span className="text-[11px] text-muted-foreground shrink-0">{c.id.slice(0, 12)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : null}
                  {showDockerRemoteContainerPickerSection ? (
                    <>
                      <div className="px-2 py-1 text-[11px] text-muted-foreground border-b border-border">
                        Docker Remote
                      </div>
                      {runningDockerRemoteContainers.length === 0 ? (
                        <div className="px-2 py-2 text-xs text-muted-foreground border-b border-border">
                          No running remote containers.
                        </div>
                      ) : (
                        <div className="max-h-32 overflow-auto border-b border-border">
                          {runningDockerRemoteContainers.map((c) => (
                            <button
                              key={`remote:${c.id}`}
                              type="button"
                              className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40 cursor-pointer"
                              onClick={() => {
                                setPickerOpen(false);
                                addTabForContainer(c, undefined, { dockerHost: remoteDockerHost });
                              }}
                              role="menuitem"
                            >
                              <span className={["h-2 w-2 rounded-full shrink-0", containerDotClass(c.id)].join(" ")} />
                              <span className="truncate flex-1">{c.name || c.id.slice(0, 12)}</span>
                              <span className="text-[11px] text-muted-foreground shrink-0">{c.id.slice(0, 12)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : null}
                </>
              ) : null}
              {showAiModelPickerSection ? (
                <>
                  <div
                    className={[
                      "px-2 py-1 text-[11px] text-muted-foreground border-border flex items-center gap-1",
                      showAnyDockerContainerPickerSection ? "border-y" : "border-b",
                    ].join(" ")}
                  >
                    <span className="flex-1">Choose an AI model</span>
                    {configuredPickerModelTypes.length > 0 ? (
                      <div className="min-w-0 flex items-center gap-1 overflow-x-auto py-0.5">
                        {configuredPickerModelTypes.map((type) => (
                          <button
                            key={type}
                            type="button"
                            aria-label={`Toggle ${MODEL_TYPE_DISPLAY[type]} models`}
                            title={MODEL_TYPE_DISPLAY[type]}
                            className={[
                              "shrink-0 rounded p-1.5",
                              selectedPickerModelTypes.includes(type)
                                ? "bg-primary text-primary-foreground"
                                : "bg-secondary text-secondary-foreground hover:text-foreground hover:bg-secondary/80",
                            ].join(" ")}
                            onClick={() =>
                              setSelectedPickerModelTypes((prev) =>
                                prev.includes(type)
                                  ? prev.filter((candidate) => candidate !== type)
                                  : [...prev, type],
                              )
                            }
                          >
                            {renderModelTypeIcon(type)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {pickerModelsLoading ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">Loading AI models...</div>
                  ) : pickerModelsError ? (
                    <div className="px-2 py-2 text-xs text-destructive">{pickerModelsError}</div>
                  ) : pickerModels.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">No AI models found.</div>
                  ) : visiblePickerModels.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">
                      No AI models match the selected model types.
                    </div>
                  ) : (
                    <div className="max-h-40 overflow-auto">
                      {visiblePickerModels.map((model) => (
                        <button
                          key={`${model.source}:${model.environment}:${model.host ?? "local"}:${model.id || model.name}`}
                          type="button"
                          className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40 cursor-pointer"
                          onClick={() => {
                            setPickerOpen(false);
                            if (model.source === "ollama") {
                              addOllamaRunTab(model.name, undefined, model.host);
                              return;
                            }
                            addModelRunTab(model.name, undefined, model.host);
                          }}
                          role="menuitem"
                        >
                          <span
                            className={[
                              "h-2 w-2 rounded-full shrink-0",
                              model.source === "ollama" ? "bg-cyan-500" : "bg-fuchsia-500",
                            ].join(" ")}
                          />
                          <span className="truncate flex-1">
                            {model.source === "docker"
                              ? formatDockerModelDisplayName(model.name)
                              : model.name}
                          </span>
                          {model.size ? (
                            <span className="text-[11px] text-muted-foreground shrink-0">{model.size}</span>
                          ) : null}
                          <span className="text-[11px] text-muted-foreground shrink-0">
                            {model.sourceLabel}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Shell panes */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <ShellPane
            key={tab.id}
            tabId={tab.id}
            containerId={tab.containerId}
            kind={tab.kind}
            modelName={tab.modelName}
            initialSessionId={tab.sessionId}
            dockerHost={tab.dockerHost ?? dockerHost}
            ollamaHost={tab.ollamaHost ?? ollamaHost}
            activeContainerId={activeContainerId}
            visible={tab.id === activeTabId}
            cwd={tab.cwd}
            onSessionExit={onSessionExit}
            onSessionIdChange={onSessionIdChange}
            onShellDetected={onShellDetected}
            onOpenPathCommand={onOpenPathCommand}
            connectRef={connectFnsRef}
            onPaneReady={onPaneReady}
            onPaneGone={onPaneGone}
            destroySessionOnUnmount={false}
            terminalTheme={terminalTheme}
          />
        ))}
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            {runningContainers.length === 0
              ? localTerminalEnabled
                ? "No shells open. Click + to open a local shell, or start a container in Environment."
                : "No shells open. Start a container in Environment."
              : localTerminalEnabled
                ? "No shells open. Click + to choose a local shell or container."
                : "No shells open. Click + to choose a container."}
          </div>
        )}
      </div>
    </div>
  );
}
