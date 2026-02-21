import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Bot,
  ChevronRight,
  Download,
  Eye,
  Image as ImageIcon,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Video,
} from "lucide-react";
import { IconButton } from "./IconButton";
import * as ollamaClient from "../lib/ollama";
import type { OllamaModelInfo } from "../electrobun/rpcSchema";
import {
  MODEL_TYPE_DISPLAY,
  MODEL_TYPE_LABELS,
  type ProviderModel,
  type ProviderModelType,
} from "../lib/modelProviders";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  onRunModel: (modelName: string) => void;
  onPullModel: (modelName: string) => void;
  onShowModelInspect?: (modelName: string) => void;
  configuredAiModels?: ProviderModel[];
  ollamaHost?: string | null;
};

type OpenMenu = {
  id: string;
  left: number;
  top: number;
  anchorLeft: number;
  anchorTop: number;
  align: "left" | "right";
};

const compareResourceNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const renderModelTypeIcon = (type: ProviderModelType) => {
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
};

// ---------------------------------------------------------------------------
// OllamaView
// ---------------------------------------------------------------------------

export function OllamaView({
  onRunModel,
  onPullModel,
  onShowModelInspect,
  configuredAiModels = [],
  ollamaHost = null,
}: Props) {
  const CONTEXT_MENU_MARGIN = 8;
  const CONTEXT_MENU_ESTIMATED_WIDTH = 200;
  const CONTEXT_MENU_ESTIMATED_HEIGHT = 220;
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(true);
  const [selectedModelTypes, setSelectedModelTypes] = useState<ProviderModelType[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pullInput, setPullInput] = useState("");
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const pullInputRef = useRef<HTMLInputElement>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      await ollamaClient.configureOllamaHost(ollamaHost);
      const listed = await ollamaClient.listModels();
      setModels(listed.filter((m) => Boolean((m.name ?? "").trim())));
    } catch {
      // ignore
    } finally {
      setModelsLoading(false);
    }
  }, [ollamaHost]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const handlePull = useCallback(() => {
    const name = pullInput.trim();
    if (!name) return;
    onPullModel(name);
    setPullInput("");
    pullInputRef.current?.focus();
  }, [pullInput, onPullModel]);

  const closeMenu = useCallback(() => setOpenMenu(null), []);

  const clampContextMenuPosition = useCallback(
    (left: number, top: number, menuWidth: number, menuHeight: number) => {
      if (typeof window === "undefined") return { left, top };
      const maxLeft = Math.max(
        CONTEXT_MENU_MARGIN,
        window.innerWidth - CONTEXT_MENU_MARGIN - Math.max(0, menuWidth),
      );
      const maxTop = Math.max(
        CONTEXT_MENU_MARGIN,
        window.innerHeight - CONTEXT_MENU_MARGIN - Math.max(0, menuHeight),
      );
      return {
        left: Math.min(Math.max(left, CONTEXT_MENU_MARGIN), maxLeft),
        top: Math.min(Math.max(top, CONTEXT_MENU_MARGIN), maxTop),
      };
    },
    [CONTEXT_MENU_MARGIN],
  );

  const openContextMenu = useCallback((e: ReactMouseEvent<HTMLElement>, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const clamped = clampContextMenuPosition(
      e.clientX,
      e.clientY,
      CONTEXT_MENU_ESTIMATED_WIDTH,
      CONTEXT_MENU_ESTIMATED_HEIGHT,
    );
    setOpenMenu({
      id,
      left: clamped.left,
      top: clamped.top,
      anchorLeft: e.clientX,
      anchorTop: e.clientY,
      align: "left",
    });
  }, [clampContextMenuPosition]);

  useEffect(() => {
    if (!openMenu) return;
    const recalc = () => {
      const rect = menuPanelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clamped = clampContextMenuPosition(openMenu.anchorLeft, openMenu.anchorTop, rect.width, rect.height);
      if (clamped.left !== openMenu.left || clamped.top !== openMenu.top) {
        setOpenMenu((prev) => (prev ? { ...prev, left: clamped.left, top: clamped.top } : prev));
      }
    };
    recalc();
    window.addEventListener("resize", recalc);
    return () => {
      window.removeEventListener("resize", recalc);
    };
  }, [clampContextMenuPosition, openMenu]);

  const doAction = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setActionBusy(true);
      setError(null);
      try {
        await fn();
        await refreshModels();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed: ${label}`);
      } finally {
        setActionBusy(false);
      }
    },
    [refreshModels],
  );

  const unloadModelAndWaitForState = useCallback(async (modelName: string) => {
    await ollamaClient.configureOllamaHost(ollamaHost);
    await ollamaClient.unloadModel(modelName);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        await ollamaClient.configureOllamaHost(ollamaHost);
        const listed = await ollamaClient.listModels();
        const model = listed.find((m) => m.name === modelName);
        if (!model || !model.running) return;
      } catch {
        // Best effort polling; final UI refresh still runs after this action.
      }
    }
  }, [ollamaHost]);

  const configuredModelTypes = useMemo(
    () =>
      MODEL_TYPE_LABELS.filter((type) =>
        configuredAiModels.some((model) => Boolean(model.enabledTypes[type])),
      ),
    [configuredAiModels],
  );
  const configuredModelTypesById = useMemo(() => {
    const result = new Map<string, ProviderModelType[]>();
    for (const model of configuredAiModels) {
      const modelId = model.id.trim().toLowerCase();
      if (!modelId) continue;
      result.set(
        modelId,
        MODEL_TYPE_LABELS.filter((type) => Boolean(model.enabledTypes[type])),
      );
    }
    return result;
  }, [configuredAiModels]);
  const visibleModels = useMemo(
    () =>
      models.filter((model) => {
        if (selectedModelTypes.length === 0) return true;
        const types = configuredModelTypesById.get(model.name.trim().toLowerCase()) ?? [];
        return types.some((type) => selectedModelTypes.includes(type));
      }),
    [configuredModelTypesById, models, selectedModelTypes],
  );
  const sortedVisibleModels = useMemo(
    () => [...visibleModels].sort((a, b) => compareResourceNames(a.name, b.name)),
    [visibleModels],
  );

  useEffect(() => {
    setSelectedModelTypes((prev) =>
      prev.filter((type) => configuredModelTypes.includes(type)),
    );
  }, [configuredModelTypes]);

  // Build menu content for each model row (populated during render)
  const menuContentById = new Map<string, ReactNode>();

  return (
    <div className="flex flex-col text-sm min-h-0 h-full">
      {/* ── Pull Model ── */}
      <div className="border-b p-2 space-y-2 bg-background">
        <div className="flex gap-1.5 px-1">
          <input
            ref={pullInputRef}
            type="text"
            className="flex-1 min-w-0 rounded border-input bg-background px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="e.g. llama3.2, phi3, mistral"
            value={pullInput}
            onChange={(e) => setPullInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePull();
            }}
          />
          <button
            type="button"
            aria-label="Pull model"
            title="Pull model"
            className="shrink-0 rounded bg-secondary text-secondary-foreground px-2 py-1 text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handlePull}
            disabled={!pullInput.trim()}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="mx-2 mt-2 rounded-md bg-destructive/10 border border-destructive/30 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {/* ── AI Models ── */}
      <div className="border-b flex flex-col min-h-0">
        <div className="flex items-center bg-background">
          <button
            type="button"
            className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
            onClick={() => setModelsOpen((prev) => !prev)}
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 transition-transform ${modelsOpen ? "rotate-90" : ""}`}
            />
            <span>AI Models</span>
            {models.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                ({visibleModels.length}/{models.length})
              </span>
            )}
          </button>
          {modelsOpen && (
            <div className="shrink min-w-0 flex items-center gap-1 pr-1">
              {configuredModelTypes.length > 0 && (
                <div className="min-w-0 flex items-center gap-1 overflow-x-auto py-1">
                  {configuredModelTypes.map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-label={`Toggle ${MODEL_TYPE_DISPLAY[type]} models`}
                      title={MODEL_TYPE_DISPLAY[type]}
                      className={[
                        "shrink-0 rounded p-1.5",
                        selectedModelTypes.includes(type)
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary/20 text-secondary-foreground hover:text-foreground hover:bg-secondary/80",
                      ].join(" ")}
                      onClick={() =>
                        setSelectedModelTypes((prev) =>
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
              )}
              <div title="Refresh AI models" onClick={() => void refreshModels()}>
                <RefreshCw className={`h-3 w-3 ${modelsLoading ? "animate-spin" : ""}`} />
              </div>
            </div>
          )}
        </div>

        {modelsOpen && (
          <div className="flex-1 min-h-0 overflow-auto px-2 pb-2 space-y-1">
            {models.length === 0 && !modelsLoading && (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No models found. Pull a model to get started.
              </div>
            )}
            {models.length > 0 && visibleModels.length === 0 && (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No models match the selected model types.
              </div>
            )}
            <ul className="space-y-1">
              {sortedVisibleModels.map((model) => {
                const menuId = `ollama-model:${model.name}`;
                const modelTypes =
                  configuredModelTypesById.get(model.name.trim().toLowerCase()) ?? [];

                const modelMenu = (
                  <>
                    {model.running && (
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 border-b text-left text-xs hover:bg-muted"
                        onClick={() => {
                          closeMenu();
                          void doAction("unload model", () => unloadModelAndWaitForState(model.name));
                        }}
                      >
                        Unload Ollama Model
                      </button>
                    )}
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => {
                        closeMenu();
                        onRunModel(model.name);
                      }}
                      disabled={actionBusy}
                    >
                      Run in Terminal
                    </button>
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => {
                        closeMenu();
                        onShowModelInspect?.(model.name);
                      }}
                    >
                      Inspect model
                    </button>
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted mt-1 border-t pt-2"
                      onClick={() => {
                        closeMenu();
                        void doAction("remove AI model", () => ollamaClient.removeModel(model.name));
                      }}
                      disabled={actionBusy}
                    >
                      DELETE OLLAMA MODEL
                    </button>
                  </>
                );

                menuContentById.set(menuId, modelMenu);

                return (
                  <li
                    key={model.name}
                    className="group rounded-md px-2 py-2 text-xs bg-muted/30 hover:bg-muted/60"
                    onContextMenu={(e) => openContextMenu(e, menuId)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-1.5">
                        <span
                          className={`inline-block h-2 w-2 rounded-full shrink-0 ${model.running ? "bg-emerald-500" : "bg-muted-foreground/40"
                            }`}
                        />
                        <span className="font-medium text-foreground truncate min-w-0 flex-1">
                          {model.name}
                          {(model.size) && (
                            <span className="ml-2 mt-1 truncate text-[10px] text-muted-foreground">
                              {model.size}
                            </span>
                          )}
                        </span>
                      </div>
                      <span className="flex-1"></span>
                      {modelTypes.length > 0 && (
                        <div className="mt-1 inline-flex gap-1">
                          {modelTypes.map((type) => (
                            <span
                              key={type}
                              title={MODEL_TYPE_DISPLAY[type]}
                              aria-label={MODEL_TYPE_DISPLAY[type]}
                              className="rounded bg-muted p-1 text-muted-foreground opacity-25 hover:opacity-100"
                            >
                              {renderModelTypeIcon(type)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* ── Context menu portal ── */}
      {openMenu && typeof document !== "undefined" &&
        createPortal(
          <>
            <button
              type="button"
              className="fixed inset-0 z-[10000] cursor-default bg-muted/50"
              onClick={closeMenu}
            />
            <div
              ref={menuPanelRef}
              className={[
                "fixed z-[10001] min-w-40 rounded-md border bg-background p-1 shadow-2xl",
                openMenu.align === "right" ? "-translate-x-full" : "",
              ].join(" ")}
              style={{ left: openMenu.left, top: openMenu.top }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {menuContentById.get(openMenu.id)}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
