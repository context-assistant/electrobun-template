import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { useInAppDialogs } from "../context/InAppDialogsContext";
import { CustomSelect } from "./CustomSelect";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import { applyBashAliasesToContainer as applyZshAliasesToContainer } from "../lib/bashAliases";
import type {
  AIModelInfo,
  ContainerInfo,
  ContainerInspect,
  CreateContainerParams,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from "../electrobun/rpcSchema";
import { ContainerFilesTab } from "./ContainerFilesTab";
import {
  MODEL_TYPE_DISPLAY,
  MODEL_TYPE_LABELS,
  type ProviderModel,
  type ProviderModelType,
} from "../lib/modelProviders";
import {
  createEmptyContainerShell,
  getConfiguredContainerShells,
  normalizeContainerShells,
  parseContainerShellsLabel,
  type ContainerShell,
} from "../lib/containerShells";
import { readJSON, writeJSON } from "../lib/localStorage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  dockerContainers: ContainerInfo[];
  dockerAvailable: boolean | null;
  dockerHost?: string | null;
  fallbackAiModels?: AIModelInfo[];
  configuredAiModels?: ProviderModel[];
  dockerSectionVisibility?: {
    image: boolean;
    app: boolean;
    container: boolean;
    files: boolean;
    volume: boolean;
    aiModel: boolean;
    network: boolean;
  };
  onUpdateDockerSectionVisibility?: (section: AccordionSection, visible: boolean) => void;
  onRefreshContainers: () => Promise<void>;
  activeContainerId: string | null;
  onSelectContainer: (containerId: string | null) => void;
  onActiveContainerStateChange?: (state: string | null) => void;
  onWorkspaceMountChange?: (hasMount: boolean) => void;
  onShowContainerLogs?: (containerId: string) => void;
  onShowContainerInspect?: (containerId: string) => void;
  onShowModelInspect?: (modelName: string) => void;
  onShowContainerTerminal?: (containerId: string, shell?: string | null, shellName?: string | null) => void;
  onRunAiModel?: (modelName: string) => void;
  onPullImage?: (imageName: string) => void;
  onPullAiModel?: (modelName: string) => void;
  selectedRunningContainerId?: string | null;
  selectedRunningContainerName?: string | null;
  onOpenFileTemporary?: (filePath: string) => boolean;
  onOpenFileEdit?: (filePath: string) => boolean;
  fileBrowserRefreshNonce?: number;
  onFileBrowserRefresh?: () => void;
  onFileBrowserWorkingDirectoryChange?: (containerId: string, cwd: string | null) => void;
  fileBrowserRevealRequest?: { nonce: number; path: string; kind: "file" | "directory" } | null;
  hasRemoteDockerHost?: boolean;
};

type AccordionSection = "image" | "app" | "container" | "files" | "volume" | "aiModel" | "network";

type CreateContainerFormState = {
  image: string;
  name: string;
  /** Container + terminal user. "auto" uses the image default (if any). */
  user: string;
  /** Volume mounts (named volumes). */
  attachedVolumes: Array<{ volume: string; containerPath: string }>;
  /** User-defined mount paths in the create/edit form. */
  userDefinedVolumePaths: string[];
  ports: string; // e.g. "8080:80, 3000:3000"
  envVars: string; // e.g. "KEY=VALUE\nKEY2=VALUE2"
  command: string;
  commandWorkdir: string;
  containerShells: ContainerShell[];
  execShellWorkdir: string;
  readOnly: boolean;
  /** Mount tmpfs at /tmp (e.g. for writable temp space on read-only rootfs). */
  tmpfsTmp: boolean;
  mountDockerSocket: boolean;
  netHost: boolean;
  gpusAll: boolean;
  sshAgent: boolean;
  sshAgentHostSocketPath: string;
  gitConfig: boolean;
  gitConfigHostPath: string;
  memoryLimit: string;
  cpuLimit: string;
  showAdvanced: boolean;
  /** When editing, holds the container ID being replaced */
  editingContainerId: string | null;
  /** When editing, whether the container was running before edits */
  editingContainerWasRunning: boolean;
};

const EMPTY_FORM: CreateContainerFormState = {
  image: "",
  name: "",
  user: "",
  attachedVolumes: [],
  userDefinedVolumePaths: [],
  ports: "",
  envVars: "",
  command: "sleep infinity",
  commandWorkdir: "",
  containerShells: [],
  execShellWorkdir: "",
  readOnly: true,
  tmpfsTmp: true,
  mountDockerSocket: false,
  netHost: false,
  gpusAll: false,
  sshAgent: false,
  sshAgentHostSocketPath: "",
  gitConfig: false,
  gitConfigHostPath: "",
  memoryLimit: "",
  cpuLimit: "",
  showAdvanced: false,
  editingContainerId: null,
  editingContainerWasRunning: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_SECTION_KEY = "context-assistant.env-section.v1";
const SECTION_SIZE_KEY = "context-assistant.env-section-size.v1";
const CONTAINER_VISIBILITY_KEY = "context-assistant.container-visibility.v1";
const HIDDEN_RUNNING_CONTAINER_IDS_KEY = "context-assistant.hidden-running-container-ids.v1";
const HIDDEN_RUNNING_CONTAINERS_EVENT = "context-assistant:hidden-running-containers-changed";
const SECTION_ORDER: AccordionSection[] = ["image", "app", "container", "files", "volume", "aiModel", "network"];
const DEFAULT_SECTION_VISIBILITY: Record<AccordionSection, boolean> = {
  image: true,
  app: true,
  container: true,
  files: true,
  volume: true,
  aiModel: true,
  network: true,
};

const DEFAULT_WORKSPACE_VOLUME = "workspace";
const DEFAULT_ROOT_VOLUME = "root";
const DEFAULT_HOME_VOLUME = "home";
const SUGGESTED_CONTAINER_SHELL_COMMANDS = [
  "bash",
  "/bin/bash",
  "sh",
  "/bin/sh",
  "ash",
  "/bin/ash",
  "vim",
  "codex --oss",
];
const HIDDEN_CONTAINER_NAMES = new Set<string>(["context-assistant-host"]);
const DEFAULT_HIDDEN_RUNNING_CONTAINER_NAMES = new Set<string>(["docker-model-runner"]);

/**
 * Docker "anonymous" volumes are typically named as a long hex string.
 * We treat those as "Unnamed Volumes" in the UI to reduce clutter.
 */
const isUnnamedVolumeName = (name: string) => /^[0-9a-f]{12,}$/i.test(name);
const compareResourceNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const sameStringArray = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const isAiModelRunning = (model: AIModelInfo): boolean =>
  Boolean(model.running) || /\brunning\b/i.test(model.status ?? "");
const formatDockerAiModelDisplayName = (name: string): string => {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("docker.io/ai/")
    ? trimmed.slice("docker.io/ai/".length)
    : trimmed;
};
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

/**
 * Derive a container name from a Docker image reference.
 * e.g. "dhi.io/deno:2-debian13-dev" → "deno-2-debian13-dev"
 *      "node:20"                    → "node-20"
 *      "ubuntu"                     → "ubuntu"
 */
const deriveContainerName = (image: string): string => {
  const trimmed = image.trim();
  if (!trimmed) return "";
  // Strip registry/org prefix (everything up to and including the last '/')
  const afterSlash = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  // Replace colon (tag separator) with dash
  return afterSlash.replace(/:/g, "-");
};

const isReservedMountPath = (p: string) =>
  p === "/tmp" ||
  p.startsWith("/tmp/") ||
  p === "/root" ||
  p.startsWith("/root/") ||
  p === "/home" ||
  p.startsWith("/home/");

const sanitizeDockerRepo = (raw: string): string => {
  // Docker repository names are typically lowercase and use [a-z0-9._-] with '/' segments.
  // We keep it conservative since this is just a suggestion for the prompt.
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");
};

// ---------------------------------------------------------------------------
// EnvironmentView
// ---------------------------------------------------------------------------

export function EnvironmentView({
  dockerContainers,
  dockerAvailable,
  dockerHost = null,
  fallbackAiModels = [],
  configuredAiModels = [],
  dockerSectionVisibility = DEFAULT_SECTION_VISIBILITY,
  onUpdateDockerSectionVisibility,
  onRefreshContainers,
  activeContainerId,
  onSelectContainer,
  onActiveContainerStateChange,
  onWorkspaceMountChange,
  onShowContainerLogs,
  onShowContainerInspect,
  onShowModelInspect,
  onShowContainerTerminal,
  onRunAiModel,
  onPullImage,
  onPullAiModel,
  selectedRunningContainerId = null,
  selectedRunningContainerName = null,
  onOpenFileTemporary,
  onOpenFileEdit,
  fileBrowserRefreshNonce = 0,
  onFileBrowserRefresh,
  onFileBrowserWorkingDirectoryChange,
  fileBrowserRevealRequest = null,
  hasRemoteDockerHost = false,
}: Props) {
  const { askPrompt } = useInAppDialogs();
  const containers = dockerContainers.filter((c) => !HIDDEN_CONTAINER_NAMES.has(c.name));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<null | {
    id: string;
    left: number;
    top: number;
    anchorLeft: number;
    anchorTop: number;
    align: "left" | "right";
  }>(null);
  const [writeModeWarningOpen, setWriteModeWarningOpen] = useState(false);
  const [writeModeTargetId, setWriteModeTargetId] = useState<string | null>(null);
  const [writableWarningTooltip, setWritableWarningTooltip] = useState<null | { left: number; top: number }>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState<CreateContainerFormState>(EMPTY_FORM);
  const [editingContainerOriginalCommand, setEditingContainerOriginalCommand] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [networks, setNetworks] = useState<NetworkInfo[]>([]);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [aiModels, setAiModels] = useState<AIModelInfo[]>(fallbackAiModels);
  const [selectedAiModelTypes, setSelectedAiModelTypes] = useState<ProviderModelType[]>([]);
  const [aiModelLoading, setAiModelLoading] = useState(false);
  const [formImageUsers, setFormImageUsers] = useState<string[]>([]);
  const [formImageUsersBusy, setFormImageUsersBusy] = useState(false);
  const [formImageUsersError, setFormImageUsersError] = useState<string | null>(null);
  const [devToolsBusy, setDevToolsBusy] = useState<string | null>(null); // volume name being installed
  const [devToolsStatus, setDevToolsStatus] = useState<string | null>(null);
  const [pullImageInput, setPullImageInput] = useState("");
  const pullImageInputRef = useRef<HTMLInputElement>(null);
  const [pullAiModelInput, setPullAiModelInput] = useState("");
  const pullAiModelInputRef = useRef<HTMLInputElement>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const CONTEXT_MENU_MARGIN = 8;
  const CONTEXT_MENU_ESTIMATED_WIDTH = 200;
  const CONTEXT_MENU_ESTIMATED_HEIGHT = 260;
  // Accordion state — multiple sections can be open at once
  const [openSections, setOpenSections] = useState<Set<AccordionSection>>(() => {
    try {
      const parsed = readJSON<string[]>(ACTIVE_SECTION_KEY);
      if (parsed) {
        const valid = new Set<AccordionSection>(["image", "app", "container", "files", "volume", "aiModel", "network"]);
        return new Set(parsed.filter((s): s is AccordionSection => valid.has(s as AccordionSection)));
      }
      return new Set<AccordionSection>(["image", "app", "container"]);
    } catch {
      return new Set<AccordionSection>(["image", "app", "container"]);
    }
  });
  const [sectionWeights, setSectionWeights] = useState<Partial<Record<AccordionSection, number>>>(() => {
    try {
      const parsed = readJSON<Record<string, unknown>>(SECTION_SIZE_KEY);
      if (!parsed) return {};
      const valid = new Set<AccordionSection>(["image", "app", "container", "files", "volume", "aiModel", "network"]);
      const next: Partial<Record<AccordionSection, number>> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (!valid.has(key as AccordionSection) || typeof value !== "number" || !Number.isFinite(value)) continue;
        next[key as AccordionSection] = Math.max(0.1, value);
      }
      return next;
    } catch {
      return {};
    }
  });
  const resizeStateRef = useRef<null | {
    upperSection: AccordionSection;
    lowerSection: AccordionSection;
    startY: number;
    openTotalWeight: number;
    upperStartWeight: number;
    pairStartWeight: number;
    minWeight: number;
  }>(null);
  const sectionContainerRef = useRef<HTMLDivElement | null>(null);

  const [containerVisibility, setContainerVisibility] = useState<"all" | "running">(() => {
    try {
      const stored = readJSON<string>(CONTAINER_VISIBILITY_KEY);
      return stored === "all" || stored === "running" ? stored : "running";
    } catch {
      return "running";
    }
  });
  const [hiddenRunningContainerIds, setHiddenRunningContainerIds] = useState<Set<string>>(() => {
    try {
      const parsed = readJSON<unknown>(HIDDEN_RUNNING_CONTAINER_IDS_KEY);
      if (!parsed) return new Set();
      if (!Array.isArray(parsed)) return new Set();
      const ids = parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      return new Set(ids);
    } catch {
      return new Set();
    }
  });
  const [selectedComposeProject, setSelectedComposeProject] = useState<string | null>(null);

  const configuredAiModelTypes = useMemo(
    () =>
      MODEL_TYPE_LABELS.filter((type) =>
        configuredAiModels.some((model) => Boolean(model.enabledTypes[type])),
      ),
    [configuredAiModels],
  );
  const configuredAiModelTypesById = useMemo(() => {
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
  const visibleAiModels = useMemo(
    () =>
      aiModels.filter((model) => {
        if (selectedAiModelTypes.length === 0) return true;
        const modelTypes = configuredAiModelTypesById.get(model.name.trim().toLowerCase()) ?? [];
        return modelTypes.some((type) => selectedAiModelTypes.includes(type));
      }),
    [aiModels, configuredAiModelTypesById, selectedAiModelTypes],
  );

  useEffect(() => {
    setSelectedAiModelTypes((prev) =>
      prev.filter((type) => configuredAiModelTypes.includes(type)),
    );
  }, [configuredAiModelTypes]);

  // Volumes are loaded for the create/edit form (Attached Volumes).
  const [volumes, setVolumes] = useState<VolumeInfo[]>([]);
  const [volumeLoading, setVolumeLoading] = useState(false);
  const [showUnnamedVolumes, setShowUnnamedVolumes] = useState(false);
  const [activeImageDeclaredVolumePaths, setActiveImageDeclaredVolumePaths] = useState<string[]>([]);
  const [formImageDeclaredVolumePaths, setFormImageDeclaredVolumePaths] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      await onRefreshContainers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to refresh containers");
    } finally {
      setLoading(false);
    }
  }, [onRefreshContainers]);

  // Keep selection/workspace state coherent when Docker becomes unavailable.
  useEffect(() => {
    if (dockerAvailable !== false) return;
    if (activeContainerId) {
      onSelectContainer(null);
    }
    onWorkspaceMountChange?.(false);
  }, [activeContainerId, dockerAvailable, onSelectContainer, onWorkspaceMountChange]);

  // Report active container state to parent
  useEffect(() => {
    if (!onActiveContainerStateChange) return;
    if (!activeContainerId) {
      onActiveContainerStateChange(null);
      return;
    }
    const active = containers.find((c) => c.id === activeContainerId);
    onActiveContainerStateChange(active?.state ?? null);
  }, [containers, activeContainerId, onActiveContainerStateChange]);

  // Persist accordion sections
  useEffect(() => {
    try {
      writeJSON(ACTIVE_SECTION_KEY, [...openSections]);
    } catch { /* ignore */ }
  }, [openSections]);
  useEffect(() => {
    try {
      writeJSON(SECTION_SIZE_KEY, sectionWeights);
    } catch {
      // ignore
    }
  }, [sectionWeights]);
  useEffect(() => {
    try {
      writeJSON(CONTAINER_VISIBILITY_KEY, containerVisibility);
    } catch {
      // ignore
    }
  }, [containerVisibility]);
  useEffect(() => {
    try {
      writeJSON(HIDDEN_RUNNING_CONTAINER_IDS_KEY, [...hiddenRunningContainerIds]);
      window.dispatchEvent(new Event(HIDDEN_RUNNING_CONTAINERS_EVENT));
    } catch {
      // ignore
    }
  }, [hiddenRunningContainerIds]);
  // Keep hidden-running IDs as a stable user preference; do not auto-prune per render.
  // In multi-environment mode, aggressive pruning can oscillate between local/remote views.
  const runDockerTask = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T> =>
      await dockerClient.runWithDockerHost(dockerHost, task),
    [dockerHost],
  );

  // Read declared `VOLUME` paths from the active container's image.
  useEffect(() => {
    let cancelled = false;
    const setActiveDeclaredVolumePaths = (next: string[]) => {
      setActiveImageDeclaredVolumePaths((prev) => (sameStringArray(prev, next) ? prev : next));
    };
    const run = async () => {
      if (!activeContainerId) {
        setActiveDeclaredVolumePaths([]);
        return;
      }
      const activeContainerExists = containers.some((container) => container.id === activeContainerId);
      if (!activeContainerExists) {
        setActiveDeclaredVolumePaths([]);
        return;
      }
      try {
        const info = await runDockerTask(async () => await dockerClient.inspectContainer(activeContainerId));
        const raw = info.config?.volumes ?? [];
        const unique = Array.from(new Set(raw.filter((p) => typeof p === "string" && p.trim()))).sort((a, b) =>
          a.localeCompare(b),
        );
        if (!cancelled) setActiveDeclaredVolumePaths(unique);
      } catch {
        if (!cancelled) setActiveDeclaredVolumePaths([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeContainerId, containers]);

  // When creating/editing, derive declared VOLUME paths for the selected image.
  useEffect(() => {
    let cancelled = false;
    const setFormDeclaredVolumePaths = (next: string[]) => {
      setFormImageDeclaredVolumePaths((prev) => (sameStringArray(prev, next) ? prev : next));
    };
    const run = async () => {
      if (!showCreateModal) {
        setFormDeclaredVolumePaths([]);
        return;
      }
      const image = form.image.trim();
      if (!image) {
        setFormDeclaredVolumePaths([]);
        return;
      }
      try {
        const paths = await runDockerTask(async () => await dockerClient.inspectImageDeclaredVolumes(image));
        const unique = Array.from(new Set((paths ?? []).filter((p) => typeof p === "string" && p.trim()))).sort((a, b) =>
          a.localeCompare(b),
        );
        if (!cancelled) setFormDeclaredVolumePaths(unique);
      } catch {
        if (!cancelled) setFormDeclaredVolumePaths([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [form.image, showCreateModal]);

  // When creating/editing, list candidate users from the selected image.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (!showCreateModal) {
        setFormImageUsers([]);
        setFormImageUsersBusy(false);
        setFormImageUsersError(null);
        return;
      }
      const image = form.image.trim();
      if (!image) {
        setFormImageUsers([]);
        setFormImageUsersBusy(false);
        setFormImageUsersError(null);
        return;
      }
      setFormImageUsersBusy(true);
      setFormImageUsersError(null);
      try {
        const users = await runDockerTask(async () => await dockerClient.listImageUsers(image));
        if (!cancelled) setFormImageUsers(users ?? []);
      } catch (e) {
        if (!cancelled) {
          setFormImageUsers([]);
          setFormImageUsersError(e instanceof Error ? e.message : "Failed to list image users");
        }
      } finally {
        if (!cancelled) setFormImageUsersBusy(false);
      }
    };

    // Light debounce while typing image names.
    timer = setTimeout(() => void run(), 350);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [form.image, showCreateModal]);

  // Refresh volumes list
  const refreshVolumes = useCallback(async () => {
    setVolumeLoading(true);
    try {
      const vols = await runDockerTask(async () => await dockerClient.listVolumes());
      setVolumes(vols);
    } catch {
      // silently handle
    } finally {
      setVolumeLoading(false);
    }
  }, [runDockerTask]);

  const refreshNetworks = useCallback(async () => {
    setNetworkLoading(true);
    try {
      const listed = await runDockerTask(async () => await dockerClient.listNetworks());
      setNetworks(listed);
    } catch {
      // silently handle
    } finally {
      setNetworkLoading(false);
    }
  }, [runDockerTask]);

  const refreshAiModels = useCallback(async () => {
    setAiModelLoading(true);
    try {
      const listed = await runDockerTask(async () => await dockerClient.listAiModels());
      setAiModels(listed.filter((m) => Boolean((m.name ?? "").trim())));
    } catch {
      // Keep existing data and fall back to cached host-specific models when available.
      setAiModels((prev) =>
        prev.length > 0
          ? prev
          : fallbackAiModels.filter((m) => Boolean((m.name ?? "").trim())),
      );
    } finally {
      setAiModelLoading(false);
    }
  }, [fallbackAiModels, runDockerTask]);

  useEffect(() => {
    void refreshVolumes();
  }, [refreshVolumes]);

  useEffect(() => {
    if (!dockerSectionVisibility.aiModel) return;
    void refreshAiModels();
  }, [dockerSectionVisibility.aiModel, refreshAiModels]);

  useEffect(() => {
    if (aiModels.length > 0) return;
    if (fallbackAiModels.length === 0) return;
    setAiModels(fallbackAiModels.filter((m) => Boolean((m.name ?? "").trim())));
  }, [aiModels.length, fallbackAiModels]);

  useEffect(() => {
    void refreshNetworks();
  }, [refreshNetworks]);

  // Check workspace mount on active container
  const checkWorkspaceMount = useCallback(async (containerId: string) => {
    try {
      const info = await runDockerTask(async () => await dockerClient.inspectContainer(containerId));
      // The Files tab is available when any of our file volumes are mounted.
      // /workspace: project volume (optional)
      // /home* or /root: devcontainer home volume (auto-mounted)
      // /tmp: tmpfs mount (optional)
      const hasMount = info.mounts.some((m) =>
        m.destination === "/workspace" ||
        m.destination === "/tmp" ||
        m.destination === "/home" ||
        m.destination.startsWith("/home/") ||
        m.destination === "/root" ||
        m.destination.startsWith("/root/"),
      );
      onWorkspaceMountChange?.(hasMount);
    } catch {
      onWorkspaceMountChange?.(false);
    }
  }, [onWorkspaceMountChange, runDockerTask]);

  useEffect(() => {
    if (!activeContainerId) {
      onWorkspaceMountChange?.(false);
      return;
    }
    if (dockerAvailable === false) {
      onWorkspaceMountChange?.(false);
      return;
    }
    if (loading) return;
    if (dockerAvailable === true) {
      const exists = containers.some((c) => c.id === activeContainerId);
      if (!exists) {
        onSelectContainer(null);
        onWorkspaceMountChange?.(false);
        return;
      }
    }
    void checkWorkspaceMount(activeContainerId);
  }, [
    activeContainerId,
    dockerAvailable,
    containers,
    loading,
    checkWorkspaceMount,
    onWorkspaceMountChange,
    onSelectContainer,
  ]);

  const doAction = async (label: string, fn: () => Promise<void>) => {
    setActionBusy(true);
    setError(null);
    try {
      await runDockerTask(fn);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed: ${label}`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleStart = (id: string) => doAction("start", async () => {
    await dockerClient.startContainer(id);
    try {
      await applyZshAliasesToContainer(id);
    } catch {
      // ignore alias application failures
    }
  });
  const handleStop = (id: string) => doAction("stop", () => dockerClient.stopContainer(id));
  const handleRemove = (id: string) => doAction("remove", () => dockerClient.removeContainer(id, true));

  const refreshImages = useCallback(async () => {
    try {
      const result = await runDockerTask(async () => await dockerClient.listImages());
      setImages(result);
    } catch {
      // silently ignore — datalist is a convenience
    }
  }, [runDockerTask]);

  useEffect(() => {
    void refreshImages();
  }, [refreshImages]);

  const openWritableWarningTooltip = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const width = 340;
    const margin = 8;
    const estimatedHeight = 190;
    const left = Math.min(
      Math.max(rect.left, margin),
      Math.max(margin, window.innerWidth - width - margin),
    );
    let top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - estimatedHeight - 6);
    }
    setWritableWarningTooltip({ left, top });
  };

  const closeWritableWarningTooltip = () => setWritableWarningTooltip(null);

  const buildFormFromInspect = (data: ContainerInspect, id: string): CreateContainerFormState => {
    const portEntries: string[] = [];
    if (data.hostConfig.portBindings) {
      for (const [containerPort, bindings] of Object.entries(data.hostConfig.portBindings)) {
        if (bindings) {
          for (const binding of bindings) {
            const cp = containerPort.replace(/\/tcp$/, "");
            portEntries.push(`${binding.hostPort}:${cp}`);
          }
        }
      }
    }
    const isNetHost = data.hostConfig.networkMode === "host";
    const rootUserLabel = data.config.labels?.["context-assistant.root-user"];
    const execUserLabel = (data.config.labels?.["context-assistant.exec-user"] ?? "").trim();
    const isRootUser = rootUserLabel !== "false";
    const configuredUser = (data.config.user ?? "").trim();
    const user = execUserLabel
      ? execUserLabel
      : configuredUser
        ? configuredUser
        : isRootUser
          ? "root"
          : "auto";
    const sshAgentLabel = data.config.labels?.["context-assistant.ssh-agent"];
    const isSshAgent = sshAgentLabel === "true";
    const sshAgentSource = String(data.config.labels?.["context-assistant.ssh-agent-source"] ?? "").trim();
    const gitConfigLabel = data.config.labels?.["context-assistant.gitconfig"];
    const isGitConfig = gitConfigLabel === "true";
    const gitConfigSource = String(data.config.labels?.["context-assistant.gitconfig-source"] ?? "").trim();
    const configuredContainerShells = getConfiguredContainerShells({
      containerShells: parseContainerShellsLabel(data.config.labels?.["context-assistant.exec-shells"]),
      execCommandShell: String(data.config.labels?.["context-assistant.exec-shell"] ?? "").trim(),
    });
    const execShellWorkdir = String(data.config.labels?.["context-assistant.exec-workdir"] ?? "").trim();
    const isDockerSockMounted = data.mounts.some((m) => m.destination === "/var/run/docker.sock");
    const normalizeMountKey = (containerPath: string): string => {
      const p = (containerPath ?? "").trim();
      if (!p) return p;
      if (p === "/tmp" || p.startsWith("/tmp/")) return "/tmp";
      if (p === "/root" || p.startsWith("/root/")) return "/root";
      if (p === "/home" || p.startsWith("/home/")) return "/home";
      return p;
    };

    const { attachedVolumes, hadTmpVolume } = (() => {
      const raw = data.mounts
        .filter((m) => m.type === "volume" && m.name)
        .map((m) => ({
          volume: m.name,
          rawDestination: (m.destination ?? "").trim(),
          containerPath: normalizeMountKey(m.destination),
        }))
        .filter((m) => m.volume && m.containerPath);

      // Prefer exact mounts (e.g. /home) over nested legacy mounts (e.g. /home/node)
      // when they normalize to the same mount key.
      const byPath = new Map<string, (typeof raw)[number]>();
      for (const m of raw) {
        const existing = byPath.get(m.containerPath);
        if (!existing) {
          byPath.set(m.containerPath, m);
          continue;
        }
        const existingExact = existing.rawDestination === existing.containerPath;
        const nextExact = m.rawDestination === m.containerPath;
        if (nextExact && !existingExact) {
          byPath.set(m.containerPath, m);
        }
      }

      const values = Array.from(byPath.values()).map((m) => ({ volume: m.volume, containerPath: m.containerPath }));
      const hadTmpVolume = values.some((m) => m.containerPath === "/tmp");
      return {
        hadTmpVolume,
        attachedVolumes: values.filter((m) => m.containerPath !== "/tmp"),
      };
    })();

    const hasTmpfsTmp = data.mounts.some(
      (m) => m.type === "tmpfs" && normalizeMountKey(m.destination) === "/tmp",
    );
    const userDefinedVolumePaths = attachedVolumes
      .map((m) => m.containerPath)
      .filter((p) => p && p !== "/workspace" && p !== "/root" && p !== "/home" && !isReservedMountPath(p));

    return {
      image: data.config.image || data.image,
      name: data.name,
      user,
      attachedVolumes,
      userDefinedVolumePaths,
      ports: portEntries.join(", "),
      envVars: data.config.env.join("\n"),
      command: data.config.cmd.join(" "),
      commandWorkdir: String(data.config.workingDir ?? "").trim(),
      containerShells: configuredContainerShells,
      execShellWorkdir,
      readOnly: data.hostConfig.readOnly,
      tmpfsTmp: hasTmpfsTmp || hadTmpVolume || data.hostConfig.readOnly,
      mountDockerSocket: isDockerSockMounted,
      netHost: isNetHost,
      gpusAll: data.hostConfig.gpusAll,
      sshAgent: isSshAgent,
      sshAgentHostSocketPath: sshAgentSource,
      gitConfig: isGitConfig,
      gitConfigHostPath: gitConfigSource,
      memoryLimit: "",
      cpuLimit: "",
      showAdvanced:
        data.config.env.length > 0 ||
        data.config.cmd.length > 0 ||
        data.hostConfig.readOnly ||
        hasTmpfsTmp ||
        isDockerSockMounted ||
        isNetHost ||
        data.hostConfig.gpusAll ||
        isSshAgent ||
        isGitConfig ||
        String(data.config.workingDir ?? "").trim().length > 0 ||
        configuredContainerShells.length > 0 ||
        execShellWorkdir.length > 0 ||
        sshAgentSource.length > 0 ||
        gitConfigSource.length > 0,
      editingContainerId: id,
      editingContainerWasRunning: Boolean(data.state?.running),
    };
  };

  const handleEdit = async (id: string) => {
    try {
      const data = await runDockerTask(async () => await dockerClient.inspectContainer(id));
      setEditingContainerOriginalCommand(data.config.cmd.join(" "));
      setForm(buildFormFromInspect(data, id));
      setCreateError(null);
      setShowCreateModal(true);
      void refreshImages();
      void refreshVolumes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to inspect container for editing");
    }
  };

  const openWriteModeWarning = (id: string) => {
    setWriteModeTargetId(id);
    setWriteModeWarningOpen(true);
  };

  const handleInstallBashDevToolsVolume = async (volumeName: string, scope: "root" | "home") => {
    setOpenMenu(null);
    setDevToolsBusy(volumeName);
    setDevToolsStatus(
      scope === "home"
        ? `Installing bash dev tools across home folders in ${volumeName}…`
        : `Installing bash dev tools in ${volumeName}…`,
    );
    setError(null);
    try {
      const result = await runDockerTask(async () =>
        await dockerClient.installBashDevToolsVolume(volumeName, scope),
      );
      setDevToolsStatus(
        scope === "home"
          ? `Bash dev tools installed in ${result.homesInstalled} home folder(s) on volume ${volumeName}.`
          : `Bash dev tools installed on volume ${volumeName}.`,
      );
      void refreshVolumes();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to install bash dev tools";
      setDevToolsStatus(`Error: ${message}`);
    } finally {
      setDevToolsBusy(null);
    }
  };

  const handleCommitContainer = async (container: ContainerInfo) => {
    const suggestedRepo =
      sanitizeDockerRepo(container.name) ||
      sanitizeDockerRepo(deriveContainerName(container.image)) ||
      "my-image";
    const suggested = `devcontainer:${suggestedRepo}`;

    const image = await askPrompt({
      title: "Commit container to image",
      message: "Enter image:tag for the new Docker image:",
      defaultValue: suggested,
      placeholder: "devcontainer:my-image",
    });
    if (!image) return;
    if (/\s/.test(image)) {
      setError("Image name must not contain spaces.");
      return;
    }
    await doAction("commit", async () => {
      await dockerClient.commitContainer(container.id, image);
    });
    void refreshImages();
  };

  const parsePorts = (raw: string): Array<{ host: number; container: number }> => {
    if (!raw.trim()) return [];
    return raw
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [hostStr, containerStr] = entry.split(":");
        return {
          host: parseInt(hostStr ?? "0", 10),
          container: parseInt(containerStr ?? "0", 10),
        };
      })
      .filter((p) => p.host > 0 && p.container > 0);
  };

  const parseEnv = (raw: string): Record<string, string> => {
    if (!raw.trim()) return {};
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
    return env;
  };

  const buildCreateParams = (
    sourceForm: CreateContainerFormState,
    overrides?: { image?: string; readOnly?: boolean; name?: string },
  ): CreateContainerParams => {
    const seen = new Set<string>();
    const volumes = (sourceForm.attachedVolumes ?? [])
      .map((m) => ({ volume: m.volume.trim(), containerPath: m.containerPath.trim() }))
      .filter((m) => m.volume && m.containerPath)
      .filter((m) => {
        if (seen.has(m.containerPath)) return false;
        seen.add(m.containerPath);
        return true;
      });
    const user = (sourceForm.user ?? "").trim() || "auto";
    const image = (overrides?.image ?? sourceForm.image).trim();
    const containerShells = normalizeContainerShells(sourceForm.containerShells);
    return {
      image,
      name: (overrides?.name ?? sourceForm.name).trim() || deriveContainerName(image) || undefined,
      ports: parsePorts(sourceForm.ports),
      env: parseEnv(sourceForm.envVars),
      command: sourceForm.command.trim() ? sourceForm.command.trim().split(/\s+/) : undefined,
      workdir: sourceForm.commandWorkdir.trim() || undefined,
      containerShells: containerShells.length > 0 ? containerShells : undefined,
      execShellWorkdir: sourceForm.execShellWorkdir.trim() || undefined,
      readOnly: overrides?.readOnly ?? sourceForm.readOnly,
      tmpfsTmp: sourceForm.tmpfsTmp,
      mountDockerSocket: sourceForm.mountDockerSocket,
      netHost: sourceForm.netHost,
      gpusAll: sourceForm.gpusAll,
      rootUser: user === "root",
      execUser: user === "auto" ? undefined : user,
      sshAgent: sourceForm.sshAgent,
      sshAgentHostSocketPath: sourceForm.sshAgentHostSocketPath.trim() || undefined,
      gitConfig: sourceForm.gitConfig,
      gitConfigHostPath: sourceForm.gitConfigHostPath.trim() || undefined,
      memoryLimit: sourceForm.memoryLimit.trim() || undefined,
      cpuLimit: sourceForm.cpuLimit.trim() || undefined,
      volumes: volumes.length > 0 ? volumes : undefined,
    };
  };

  const handleCreate = async (overrideForm?: CreateContainerFormState, opts?: { autoStart?: boolean }) => {
    const nextForm = overrideForm ?? form;
    const autoStart = opts?.autoStart ?? true;
    if (!nextForm.image.trim()) {
      setCreateError("Image name is required.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    try {
      await runDockerTask(async () => {
        // If editing an existing container, stop and remove the old one first
        if (nextForm.editingContainerId) {
          try {
            await dockerClient.stopContainer(nextForm.editingContainerId);
          } catch {
            // may already be stopped
          }
          await dockerClient.removeContainer(nextForm.editingContainerId, true);
        }
        const containerId = await dockerClient.createContainer(
          buildCreateParams(nextForm, {
            image: nextForm.image,
            readOnly: nextForm.readOnly,
          }),
        );
        if (autoStart) {
          // Auto-start the container
          await dockerClient.startContainer(containerId);
          try {
            await applyZshAliasesToContainer(containerId);
          } catch {
            // ignore alias application failures
          }
        }
        setShowCreateModal(false);
        setForm(EMPTY_FORM);
        setEditingContainerOriginalCommand("");
        onSelectContainer(containerId);
      });
      await refresh();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create container");
    } finally {
      setCreateBusy(false);
    }
  };

  const confirmWriteMode = async () => {
    if (!writeModeTargetId) return;
    const id = writeModeTargetId;
    setWriteModeWarningOpen(false);
    setWriteModeTargetId(null);
    setOpenMenu(null);
    setCreateError(null);
    try {
      const data = await runDockerTask(async () => await dockerClient.inspectContainer(id));
      setEditingContainerOriginalCommand(data.config.cmd.join(" "));
      const nextForm: CreateContainerFormState = {
        ...buildFormFromInspect(data, id),
        readOnly: false,
        // Make the setting visible while relaunching.
        showAdvanced: true,
      };
      setShowCreateModal(true);
      setForm(nextForm);
      void handleCreate(nextForm);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to relaunch container in write mode");
    }
  };

  const stateColor = (state: string) => {
    if (state === "running") return "text-emerald-500";
    if (state === "exited") return "text-red-400";
    if (state === "created") return "text-amber-400";
    if (state === "paused") return "text-yellow-500";
    return "text-muted-foreground";
  };

  const toggleSection = (section: AccordionSection) => {
    if (!dockerSectionVisibility[section]) return;
    setOpenMenu(null);
    setSectionWeights((prev) => {
      if (openSections.has(section)) return prev;
      const currentOpen = SECTION_ORDER.filter(
        (s) => dockerSectionVisibility[s] && openSections.has(s),
      );
      const averageWeight =
        currentOpen.length > 0
          ? currentOpen.reduce((sum, s) => sum + (prev[s] ?? 1), 0) / currentOpen.length
          : 1;
      return { ...prev, [section]: Math.max(0.1, averageWeight) };
    });
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };
  const openSectionOrder = SECTION_ORDER.filter(
    (section) => dockerSectionVisibility[section] && openSections.has(section),
  );
  const visibleSections = SECTION_ORDER.filter((section) => dockerSectionVisibility[section]);
  const hiddenSections = SECTION_ORDER.filter((section) => !dockerSectionVisibility[section]);
  const sectionLabels: Record<AccordionSection, string> = {
    image: "Images",
    app: "Apps",
    container: "Containers",
    files: "Files",
    volume: "Volumes",
    aiModel: "AI Models",
    network: "Networks",
  };
  const ensureSectionWeight = (section: AccordionSection) => {
    setSectionWeights((prev) => {
      if (typeof prev[section] === "number") return prev;
      const currentOpen = SECTION_ORDER.filter(
        (s) => dockerSectionVisibility[s] && openSections.has(s),
      );
      const averageWeight =
        currentOpen.length > 0
          ? currentOpen.reduce((sum, s) => sum + (prev[s] ?? 1), 0) / currentOpen.length
          : 1;
      return { ...prev, [section]: Math.max(0.1, averageWeight) };
    });
  };
  const setSectionVisibility = (section: AccordionSection, visible: boolean) => {
    if (!onUpdateDockerSectionVisibility) return;
    if (!visible && visibleSections.length <= 1) return;
    onUpdateDockerSectionVisibility(section, visible);
    if (visible) {
      ensureSectionWeight(section);
      setOpenSections((prev) => {
        const next = new Set(prev);
        next.add(section);
        return next;
      });
    } else {
      setOpenSections((prev) => {
        const next = new Set(prev);
        next.delete(section);
        return next;
      });
    }
    closeMenu();
  };
  const sectionHeaderMenuId = (section: AccordionSection) => `section-header:${section}`;
  const getSectionWeight = (section: AccordionSection) => sectionWeights[section] ?? 1;
  const openTotalWeight = openSectionOrder.reduce((sum, section) => sum + getSectionWeight(section), 0);
  const hasMultipleOpenSections = openSectionOrder.length > 1;
  const getNextOpenSection = (section: AccordionSection): AccordionSection | null => {
    const idx = openSectionOrder.indexOf(section);
    if (idx < 0 || idx >= openSectionOrder.length - 1) return null;
    return openSectionOrder[idx + 1] ?? null;
  };
  const shouldShowResizeAfter = (section: AccordionSection) => {
    if (!hasMultipleOpenSections) return false;
    return getNextOpenSection(section) !== null;
  };
  const sectionStyle = (section: AccordionSection, open: boolean) => {
    if (!open) return { flex: "0 0 auto" };
    const weight = getSectionWeight(section);
    return { flex: `${weight} 1 0%` };
  };

  const containerOpen = dockerSectionVisibility.container && openSections.has("container");
  const imageOpen = dockerSectionVisibility.image && openSections.has("image");
  const appOpen = dockerSectionVisibility.app && openSections.has("app");
  const filesOpen = dockerSectionVisibility.files && openSections.has("files");
  const volumeOpen = dockerSectionVisibility.volume && openSections.has("volume");
  const aiModelOpen = dockerSectionVisibility.aiModel && openSections.has("aiModel");
  const networkOpen = dockerSectionVisibility.network && openSections.has("network");
  const appScopedContainers = selectedComposeProject
    ? containers.filter((c) => (c.composeProject ?? "").trim() === selectedComposeProject)
    : containers;
  const runningContainers = appScopedContainers.filter((c) => c.state === "running");
  const visibleRunningContainers = runningContainers.filter(
    (c) => !hiddenRunningContainerIds.has(c.id) && !DEFAULT_HIDDEN_RUNNING_CONTAINER_NAMES.has(c.name),
  );
  const visibleContainers = containerVisibility === "running" ? visibleRunningContainers : appScopedContainers;
  const hasDefaultHiddenRunningContainers = runningContainers.some((c) =>
    DEFAULT_HIDDEN_RUNNING_CONTAINER_NAMES.has(c.name),
  );
  const hasHiddenRunningContainers = hiddenRunningContainerIds.size > 0 || hasDefaultHiddenRunningContainers;

  const imageLabel = (img: ImageInfo) =>
    img.tag && img.tag !== "<none>" ? `${img.repository}:${img.tag}` : img.repository;
  const isDanglingImage = (img: ImageInfo) => img.repository === "<none>" && img.tag === "<none>";
  const danglingImageCount = images.filter(isDanglingImage).length;

  const imageUsage = new Map<string, { running: number; total: number }>();
  for (const c of containers) {
    const current = imageUsage.get(c.image) ?? { running: 0, total: 0 };
    current.total += 1;
    if (c.state === "running") current.running += 1;
    imageUsage.set(c.image, current);
  }

  const appMap = new Map<string, ContainerInfo[]>();
  for (const c of containers) {
    const project = (c.composeProject ?? "").trim();
    if (!project) continue;
    const group = appMap.get(project) ?? [];
    group.push(c);
    appMap.set(project, group);
  }
  const appEntries = Array.from(appMap.entries()).sort(([a], [b]) => compareResourceNames(a, b));
  useEffect(() => {
    if (!selectedComposeProject) return;
    const exists = containers.some((c) => (c.composeProject ?? "").trim() === selectedComposeProject);
    if (!exists) setSelectedComposeProject(null);
  }, [containers, selectedComposeProject]);

  const usedVolumeNames = new Set<string>();
  for (const c of appScopedContainers) {
    const mounts = c.mounts.split(",").map((m) => m.trim()).filter(Boolean);
    for (const m of mounts) {
      usedVolumeNames.add(m);
    }
  }

  const scopedVolumes = selectedComposeProject
    ? volumes.filter((v) => usedVolumeNames.has(v.name))
    : volumes;
  const unnamedVolumes = scopedVolumes.filter((v) => isUnnamedVolumeName(v.name));
  const unnamedCount = unnamedVolumes.length;
  const clearableUnnamedVolumes = unnamedVolumes.filter((v) => !usedVolumeNames.has(v.name));
  const clearableUnnamedCount = clearableUnnamedVolumes.length;
  const visibleVolumes = (showUnnamedVolumes
    ? scopedVolumes.slice()
    : scopedVolumes.filter((v) => !isUnnamedVolumeName(v.name))
  ).sort((a, b) => {
    const aUnnamed = isUnnamedVolumeName(a.name);
    const bUnnamed = isUnnamedVolumeName(b.name);
    if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
    return compareResourceNames(a.name, b.name);
  });
  const sortedImages = useMemo(
    () =>
      [...images].sort((a, b) => {
        const byName = compareResourceNames(imageLabel(a), imageLabel(b));
        return byName !== 0 ? byName : compareResourceNames(a.id, b.id);
      }),
    [images],
  );
  const sortedVisibleContainers = useMemo(
    () =>
      [...visibleContainers].sort((a, b) => {
        const byName = compareResourceNames(a.name, b.name);
        return byName !== 0 ? byName : compareResourceNames(a.id, b.id);
      }),
    [visibleContainers],
  );
  const sortedVisibleAiModels = useMemo(
    () => [...visibleAiModels].sort((a, b) => compareResourceNames(a.name, b.name)),
    [visibleAiModels],
  );

  const usedNetworks = new Set<string>();
  const runningNetworks = new Set<string>();
  for (const c of appScopedContainers) {
    for (const n of c.networks ?? []) {
      usedNetworks.add(n);
      if (c.state === "running") runningNetworks.add(n);
    }
  }
  const visibleNetworks = selectedComposeProject
    ? networks.filter((network) => usedNetworks.has(network.name))
    : networks;

  const doResourceAction = async (
    label: string,
    fn: () => Promise<void>,
    opts?: {
      refreshContainers?: boolean;
      refreshImages?: boolean;
      refreshVolumes?: boolean;
      refreshAiModels?: boolean;
      refreshNetworks?: boolean;
    },
  ) => {
    setActionBusy(true);
    setError(null);
    try {
      await runDockerTask(fn);
      const tasks: Array<Promise<void>> = [];
      if (opts?.refreshContainers ?? true) tasks.push(refresh());
      if (opts?.refreshImages) tasks.push(refreshImages());
      if (opts?.refreshVolumes) tasks.push(refreshVolumes());
      if (opts?.refreshAiModels) tasks.push(refreshAiModels());
      if (opts?.refreshNetworks) tasks.push(refreshNetworks());
      await Promise.all(tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed: ${label}`);
    } finally {
      setActionBusy(false);
    }
  };

  const unloadAiModelAndWaitForState = useCallback(async (modelName: string) => {
    await dockerClient.unloadAiModel(modelName);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        const listed = await dockerClient.listAiModels();
        const model = listed.find((m) => m.name === modelName);
        if (!model || !isAiModelRunning(model)) return;
      } catch {
        // Best effort polling; final UI refresh still runs after this action.
      }
    }
  }, []);

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

  const closeMenu = () => setOpenMenu(null);
  const openContextMenu = (e: ReactMouseEvent<HTMLElement>, id: string) => {
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
  };

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

  const startSectionResize = (e: ReactPointerEvent<HTMLButtonElement>, section: AccordionSection) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const lowerSection = getNextOpenSection(section);
    if (!lowerSection) return;
    const containerEl = sectionContainerRef.current;
    if (!containerEl) return;
    const containerHeight = containerEl.getBoundingClientRect().height;
    if (!containerHeight || containerHeight <= 0) return;
    const currentOpenTotalWeight = openTotalWeight > 0 ? openTotalWeight : openSectionOrder.length;
    const upperStartWeight = getSectionWeight(section);
    const lowerStartWeight = getSectionWeight(lowerSection);
    const pairStartWeight = upperStartWeight + lowerStartWeight;
    let minWeight = (120 / containerHeight) * currentOpenTotalWeight;
    if (!Number.isFinite(minWeight) || minWeight <= 0) minWeight = 0.1;
    if (minWeight * 2 > pairStartWeight) minWeight = pairStartWeight / 2;
    resizeStateRef.current = {
      upperSection: section,
      lowerSection,
      startY: e.clientY,
      openTotalWeight: currentOpenTotalWeight,
      upperStartWeight,
      pairStartWeight,
      minWeight,
    };

    const onMove = (ev: PointerEvent) => {
      const current = resizeStateRef.current;
      if (!current) return;
      const activeContainerHeight = sectionContainerRef.current?.getBoundingClientRect().height ?? containerHeight;
      if (!activeContainerHeight || activeContainerHeight <= 0) return;
      const deltaPx = ev.clientY - current.startY;
      const deltaWeight = (deltaPx * current.openTotalWeight) / activeContainerHeight;
      let nextUpper = current.upperStartWeight + deltaWeight;
      nextUpper = Math.max(current.minWeight, Math.min(current.pairStartWeight - current.minWeight, nextUpper));
      const nextLower = current.pairStartWeight - nextUpper;
      setSectionWeights((prev) => ({
        ...prev,
        [current.upperSection]: Math.max(0.1, nextUpper),
        [current.lowerSection]: Math.max(0.1, nextLower),
      }));
    };
    const onUp = () => {
      resizeStateRef.current = null;
      window.removeEventListener("pointermove", onMove);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const menuContentById = new Map<string, ReactNode>();
  for (const section of SECTION_ORDER) {
    if (!dockerSectionVisibility[section]) continue;
    const menuId = sectionHeaderMenuId(section);
    const hideDisabled = visibleSections.length <= 1;
    const addDisabled = hiddenSections.length === 0;
    const sectionHeaderMenu = (
      <>
        {section === "container" && containerVisibility === "running" && hasHiddenRunningContainers && (
          <button
            type="button"
            className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted border-b"
            onClick={() => {
              setHiddenRunningContainerIds(new Set());
              closeMenu();
            }}
          >
            reset hidden containers
          </button>
        )}
        <button
          type="button"
          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          disabled={hideDisabled}
          onClick={() => setSectionVisibility(section, false)}
        >
          hide {sectionLabels[section]} section
        </button>
        <div className="relative group/section-add-submenu">
          <button
            type="button"
            className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-between gap-2"
            disabled={addDisabled}
          >
            <span>add section</span>
            <ChevronRight className="h-3 w-3 shrink-0" />
          </button>
          {!addDisabled && (
            <div className="absolute left-full top-0 ml-1 hidden min-w-40 rounded-md border bg-background p-1 shadow-2xl group-hover/section-add-submenu:block">
              {hiddenSections.map((hiddenSection) => (
                <button
                  key={hiddenSection}
                  type="button"
                  className="ml--1 w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                  onClick={() => setSectionVisibility(hiddenSection, true)}
                >
                  {sectionLabels[hiddenSection]}
                </button>
              ))}
            </div>
          )}
        </div>
      </>
    );
    menuContentById.set(menuId, sectionHeaderMenu);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Global status banners */}
      {error && (
        <div className="shrink-0 mx-2 mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {devToolsStatus && (
        <div className={`shrink-0 mx-2 mt-2 rounded-md border p-2 text-xs flex items-center gap-2 ${devToolsStatus.startsWith("Error:")
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-primary/40 bg-primary/10 text-primary-foreground"
          }`}>
          {devToolsBusy && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
          <span className="flex-1">{devToolsStatus}</span>
          {!devToolsBusy && (
            <button type="button" className="shrink-0 hover:opacity-70" onClick={() => setDevToolsStatus(null)}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {dockerAvailable === false && (
        <div className="shrink-0 mx-2 mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          Docker is not running. Please start Docker Desktop and try again.
        </div>
      )}

      {/* Accordion sections */}
      <div ref={sectionContainerRef} className="flex-1 min-h-0 flex flex-col overflow-hidden bg-muted/10">

        {/* ── Images ── */}
        <div
          className="border-b flex flex-col min-h-0"
          style={{
            ...sectionStyle("image", imageOpen),
            display: dockerSectionVisibility.image ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("image"))}>
            <button
              type="button"
              className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("image")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${imageOpen ? "rotate-90" : ""}`} />
              <span>Images</span>
              {images.length > 0 && (
                <span className="text-[10px] text-muted-foreground">({images.length})</span>
              )}
            </button>
            {imageOpen && (
              <div className="shrink-0 flex items-center gap-1 pr-1">
                <button
                  type="button"
                  className="text-[11px] text-destructive hover:underline underline-offset-4 disabled:opacity-50 px-1"
                  disabled={danglingImageCount === 0 || actionBusy}
                  title="Remove all dangling images"
                  onClick={() => {
                    void doResourceAction("prune dangling images", () => dockerClient.pruneDanglingImages(), {
                      refreshContainers: false,
                      refreshImages: true,
                    });
                  }}
                >
                  Clean{danglingImageCount > 0 ? ` (${danglingImageCount})` : ""}
                </button>
                <IconButton label="Refresh images" onClick={() => void refreshImages()}>
                  <RefreshCw className="h-3 w-3" />
                </IconButton>
              </div>
            )}
          </div>
          {imageOpen && (
            <div className="flex-1 min-h-0 overflow-auto pb-2 space-y-1">
              {/* ── Pull Image ── */}
              <div className="border-b px-2 pt-1 pb-2 space-y-1.5 bg-background">
                {/* <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs font-medium text-foreground">
                  <Download className="h-3 w-3 shrink-0" />
                  <span>Pull Docker Image</span>
                </div> */}
                <div className="flex gap-1.5 px-1">
                  <input
                    ref={pullImageInputRef}
                    type="text"
                    className="flex-1 min-w-0 rounded border-input bg-background px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="e.g. ubuntu:24.04, nginx:alpine"
                    value={pullImageInput}
                    onChange={(e) => setPullImageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && pullImageInput.trim()) {
                        onPullImage?.(pullImageInput.trim());
                        setPullImageInput("");
                        pullImageInputRef.current?.focus();
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Pull Docker image"
                    title="Pull Docker image"
                    className="shrink-0 rounded bg-secondary text-secondary-foreground px-2 py-1 text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={!pullImageInput.trim()}
                    onClick={() => {
                      if (!pullImageInput.trim()) return;
                      onPullImage?.(pullImageInput.trim());
                      setPullImageInput("");
                      pullImageInputRef.current?.focus();
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="px-2 space-y-1">
                {images.length === 0 && dockerAvailable !== false && (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No images found.
                  </div>
                )}
                <ul className="space-y-1">
                  {sortedImages.map((img) => {
                    const name = imageLabel(img);
                    const usage = imageUsage.get(name);
                    const led = usage
                      ? usage.running > 0
                        ? "text-emerald-500"
                        : "text-amber-400"
                      : "text-muted-foreground";
                    const menuId = `image:${img.id}`;
                    const imageMenu = (
                      <>
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={() => {
                            closeMenu();
                            setEditingContainerOriginalCommand("");
                            setForm((prev) => ({ ...prev, image: name }));
                            setCreateError(null);
                            setShowCreateModal(true);
                          }}
                        >
                          Use in new container
                        </button>
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={() => {
                            closeMenu();
                            void navigator.clipboard?.writeText(name);
                          }}
                        >
                          Copy image name
                        </button>
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted mt-1 border-t pt-2"
                          onClick={() => {
                            closeMenu();
                            void doResourceAction("remove image", () => dockerClient.removeImage(img.id), {
                              refreshContainers: false,
                              refreshImages: true,
                            });
                          }}
                        >
                          DELETE DOCKER IMAGE
                        </button>
                      </>
                    );
                    menuContentById.set(menuId, imageMenu);
                    return (
                      <li
                        key={img.id}
                        className="group rounded-md px-2 py-2 text-xs bg-muted/30 hover:bg-muted/60"
                        onContextMenu={(e) => openContextMenu(e, menuId)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1 flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${led} bg-current`} />
                            <span className="font-medium text-foreground truncate min-w-0 flex-1">{name}</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
          {shouldShowResizeAfter("image") && (
            <button
              type="button"
              aria-label="Resize Images section"
              className="h-1.5 w-full cursor-row-resize border-t border-border/50 bg-muted/20 hover:bg-muted/40"
              onPointerDown={(e) => startSectionResize(e, "image")}
            />
          )}
        </div>

        {/* ── Apps (docker compose) ── */}
        <div
          className="border-b flex flex-col min-h-0"
          style={{
            ...sectionStyle("app", appOpen),
            display: dockerSectionVisibility.app ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("app"))}>
            <button
              type="button"
              className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("app")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${appOpen ? "rotate-90" : ""}`} />
              <span>Apps</span>
              {appEntries.length > 0 && (
                <span className="text-[10px] text-muted-foreground">({appEntries.length})</span>
              )}
            </button>
          </div>
          {appOpen && (
            <div className="flex-1 min-h-0 overflow-auto px-2 pb-2 space-y-1">
              {appEntries.length === 0 && dockerAvailable !== false && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  No docker compose apps found.
                </div>
              )}
              <ul className="space-y-1">
                {appEntries.map(([project, appContainers]) => {
                  const running = appContainers.filter((c) => c.state === "running").length;
                  const led = running > 0 ? "text-emerald-500" : "text-red-400";
                  const isSelected = selectedComposeProject === project;
                  const menuId = `app:${project}`;
                  const appMenu = (
                    <>
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={() => {
                          closeMenu();
                          void doResourceAction("start app", async () => {
                            for (const c of appContainers) {
                              if (c.state !== "running") await dockerClient.startContainer(c.id);
                            }
                          }, { refreshContainers: true });
                        }}
                      >
                        Start app
                      </button>
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={() => {
                          closeMenu();
                          void doResourceAction("stop app", async () => {
                            for (const c of appContainers) {
                              if (c.state === "running") await dockerClient.stopContainer(c.id);
                            }
                          }, { refreshContainers: true });
                        }}
                      >
                        Stop app
                      </button>
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted mt-1 border-t pt-2"
                        onClick={() => {
                          closeMenu();
                          void doResourceAction("remove app", async () => {
                            for (const c of appContainers) {
                              await dockerClient.removeContainer(c.id, true);
                            }
                          }, { refreshContainers: true });
                        }}
                      >
                        DELETE ALL APP RESOURCES
                      </button>
                    </>
                  );
                  menuContentById.set(menuId, appMenu);
                  return (
                    <li
                      key={project}
                      className={[
                        "group rounded-md px-2 py-2 text-xs cursor-pointer mt-2",
                        isSelected
                          ? "bg-primary/10 ring-1 ring-primary/30"
                          : "bg-muted/30 hover:bg-muted/60",
                      ].join(" ")}
                      role="button"
                      tabIndex={0}
                      onContextMenu={(e) => openContextMenu(e, menuId)}
                      onClick={() => setSelectedComposeProject((prev) => (prev === project ? null : project))}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        setSelectedComposeProject((prev) => (prev === project ? null : project));
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 flex items-center gap-1.5">
                          <span className={`inline-block h-2 w-2 rounded-full ${led} bg-current`} />
                          <span className="font-medium text-foreground truncate min-w-0 flex-1">{project}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {shouldShowResizeAfter("app") && (
            <button
              type="button"
              aria-label="Resize Apps section"
              className="h-1.5 w-full cursor-row-resize border-t border-border/50 bg-muted/20 hover:bg-muted/40"
              onPointerDown={(e) => startSectionResize(e, "app")}
            />
          )}
        </div>

        {/* ── Container ── */}
        <div
          className={[
            "border-b flex flex-col min-h-0",
          ].join(" ")}
          style={{
            ...sectionStyle("container", containerOpen),
            display: dockerSectionVisibility.container ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("container"))}>
            <button
              type="button"
              className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("container")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${containerOpen ? "rotate-90" : ""}`} />
              <span>Containers</span>
              {appScopedContainers.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {containerVisibility === "running"
                    ? `(${visibleRunningContainers.length}/${appScopedContainers.length})`
                    : `(${appScopedContainers.length})`}
                </span>
              )}
            </button>
            {containerOpen && (
              <div className="shrink-0 flex items-center gap-1 pr-1">
                <div
                  className="inline-flex items-center rounded-md bg-muted/30 p-0.5 text-[10px]"
                  role="group"
                  aria-label="Container visibility"
                >
                  <button
                    type="button"
                    className={[
                      "px-2 py-1 rounded-sm font-medium transition-colors",
                      containerVisibility === "all"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    ].join(" ")}
                    aria-pressed={containerVisibility === "all"}
                    onClick={() => setContainerVisibility("all")}
                    title="Show all containers"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={[
                      "px-2 py-1 rounded-sm font-medium transition-colors",
                      containerVisibility === "running"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    ].join(" ")}
                    aria-pressed={containerVisibility === "running"}
                    onClick={() => setContainerVisibility("running")}
                    title="Hide stopped containers"
                  >
                    Running
                  </button>
                </div>
                <IconButton label="Refresh" onClick={() => void refresh()}>
                  <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                </IconButton>
                <IconButton
                  label="Create container"
                  onClick={() => {
                    setEditingContainerOriginalCommand("");
                    setForm({
                      ...EMPTY_FORM,
                      attachedVolumes: [
                        { volume: DEFAULT_WORKSPACE_VOLUME, containerPath: "/workspace" },
                        { volume: DEFAULT_ROOT_VOLUME, containerPath: "/root" },
                        { volume: DEFAULT_HOME_VOLUME, containerPath: "/home" },
                      ],
                    });
                    setCreateError(null);
                    setShowCreateModal(true);
                    void refreshImages();
                    void refreshVolumes();
                  }}
                >
                  <Plus className="h-3 w-3" />
                </IconButton>
              </div>
            )}
          </div>
          {containerOpen && (
            <div className="flex-1 min-h-0 overflow-auto px-2 pb-2 space-y-1">
              {visibleContainers.length === 0 && dockerAvailable !== false && !loading && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  {containerVisibility === "running" && appScopedContainers.length > 0
                    ? (selectedComposeProject ? "No running containers in selected app." : "No running containers.")
                    : (selectedComposeProject
                      ? "No containers found for selected app."
                      : "No containers found. Create one to get started.")}
                </div>
              )}
              <ul className="space-y-1">
                {sortedVisibleContainers.map((container) => {
                  const menuId = `container:${container.id}`;
                  const configuredContainerShells = getConfiguredContainerShells(container);
                  const primaryContainerShell = configuredContainerShells[0] ?? null;
                  const openContainerTerminal = (shell?: ContainerShell | null) => {
                    closeMenu();
                    onSelectContainer(container.id);
                    onShowContainerTerminal?.(container.id, shell?.command ?? null, shell?.name ?? null);
                  };
                  const containerMenu = (
                    <>
                      {container.state === "running" && configuredContainerShells.length > 0 && (
                        configuredContainerShells.length > 1 ? (
                          <div className="relative group/container-shell-submenu border-b">
                            <button
                              type="button"
                              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted"
                              onClick={(e) => {
                                e.stopPropagation();
                                openContainerTerminal(primaryContainerShell);
                              }}
                            >
                              <span>Open in Terminal</span>
                              <ChevronRight className="h-3 w-3 shrink-0" />
                            </button>
                            <div className="absolute left-[99%] top-0 z-10 hidden min-w-40 rounded-md border bg-background p-1 shadow-2xl group-hover/container-shell-submenu:block">
                              {configuredContainerShells.map((shell) => (
                                <button
                                  key={`${container.id}:${shell.name}:${shell.command}`}
                                  type="button"
                                  className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openContainerTerminal(shell);
                                  }}
                                >
                                  {shell.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="w-full px-2 py-1.5 border-b text-left text-xs hover:bg-muted"
                            onClick={(e) => {
                              e.stopPropagation();
                              openContainerTerminal(primaryContainerShell);
                            }}
                          >
                            Open in Terminal
                          </button>
                        )
                      )}
                      {container.state === "running" ? (
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 border-b text-left text-xs hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeMenu();
                            void handleStop(container.id);
                          }}
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 border-b text-left text-xs hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeMenu();
                            void handleStart(container.id);
                          }}
                        >
                          Start
                        </button>
                      )}
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 border-b text-left text-xs hover:bg-muted"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeMenu();
                          void handleEdit(container.id);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeMenu();
                          onSelectContainer(container.id);
                          onShowContainerInspect?.(container.id);
                        }}
                      >
                        Inspect Container
                      </button>
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeMenu();
                          onSelectContainer(container.id);
                          onShowContainerLogs?.(container.id);
                        }}
                      >
                        Container Logs
                      </button>
                      {containerVisibility === "running" && (
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            setHiddenRunningContainerIds((prev) => {
                              const next = new Set(prev);
                              next.add(container.id);
                              return next;
                            });
                            closeMenu();
                          }}
                        >
                          Hide
                        </button>
                      )}
                      {container.state === "running" && !container.readOnly && (
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeMenu();
                            void handleCommitContainer(container);
                          }}
                        >
                          Commit Container
                        </button>
                      )}
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted mt-1 border-t pt-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeMenu();
                          void handleRemove(container.id);
                        }}
                      >
                        DELETE CONTAINER
                      </button>
                    </>
                  );
                  menuContentById.set(menuId, containerMenu);
                  return (
                    <li
                      key={container.id}
                      className={[
                        "group rounded-md px-2 py-2 text-xs cursor-pointer",
                        activeContainerId === container.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-secondary text-secondary-foreground",
                      ].join(" ")}
                      role="button"
                      tabIndex={0}
                      onContextMenu={(e) => openContextMenu(e, menuId)}
                      onClick={() => {
                        if (actionBusy) return;
                        if (activeContainerId === container.id) return;
                        onSelectContainer(container.id);
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`inline-block h-2 w-2 rounded-full ${stateColor(container.state)} bg-current`} />
                            <span className="font-medium text-foreground truncate min-w-0">{container.name}</span>
                            <span className="flex-1"></span>
                            <span className="mt-0.5 text-[10px] text-muted-foreground opacity-25 truncate">
                              {container.status}
                            </span>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {shouldShowResizeAfter("container") && (
            <button
              type="button"
              aria-label="Resize Containers section"
              className="h-1.5 w-full cursor-row-resize border-t border-border/50 bg-muted/20 hover:bg-muted/40"
              onPointerDown={(e) => startSectionResize(e, "container")}
            />
          )}
        </div>

        {/* ── Files ── */}
        <div
          className="border-b flex flex-col min-h-0"
          style={{
            ...sectionStyle("files", filesOpen),
            display: dockerSectionVisibility.files ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("files"))}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("files")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${filesOpen ? "rotate-90" : ""}`} />
              <span>Files</span>
            </button>

            {filesOpen && (
              <div className="flex-1 pr-2" onClick={(e) => e.stopPropagation()}>
                <CustomSelect
                  value={selectedRunningContainerId ?? ""}
                  onChange={(v) => onSelectContainer(v || null)}
                  options={[
                    { value: "", label: runningContainers.length === 0 ? "No running containers" : "Select container" },
                    ...runningContainers.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  disabled={runningContainers.length === 0}
                  className="h-7 w-full rounded-sm bg-muted/25 px-3 text-[11px]"
                />
              </div>
            )}
          </div>
          {filesOpen && (
            <div className="flex-1 min-h-0 overflow-auto">
              {selectedRunningContainerId && onOpenFileTemporary && onOpenFileEdit && onFileBrowserRefresh ? (
                <ContainerFilesTab
                  containerId={selectedRunningContainerId}
                  containerName={selectedRunningContainerName}
                  dockerHost={dockerHost}
                  onOpenFileTemporary={onOpenFileTemporary}
                  onOpenFileEdit={onOpenFileEdit}
                  refreshNonce={fileBrowserRefreshNonce}
                  onRefresh={onFileBrowserRefresh}
                  onWorkingDirectoryChange={onFileBrowserWorkingDirectoryChange}
                  revealRequest={fileBrowserRevealRequest}
                />
              ) : (
                <div className="px-3 py-3 text-xs text-muted-foreground">
                  Select a running container to browse its files.
                </div>
              )}
            </div>
          )}
          {shouldShowResizeAfter("files") && (
            <button
              type="button"
              aria-label="Resize Files section"
              className="h-1.5 w-full cursor-row-resize border-t border-border/50 bg-muted/20 hover:bg-muted/40"
              onPointerDown={(e) => startSectionResize(e, "files")}
            />
          )}
        </div>

        {/* ── Volumes ── */}
        <div
          className="border-b flex flex-col min-h-0"
          style={{
            ...sectionStyle("volume", volumeOpen),
            display: dockerSectionVisibility.volume ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("volume"))}>
            <button
              type="button"
              className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("volume")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${volumeOpen ? "rotate-90" : ""}`} />
              <span>Volumes</span>
              {scopedVolumes.length > 0 && (
                <span className="text-[10px] text-muted-foreground">({scopedVolumes.length})</span>
              )}
            </button>
            {volumeOpen && (
              <div className="shrink-0 flex items-center gap-1 pr-1">
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-4 hover:underline disabled:opacity-50 px-1"
                  onClick={() => setShowUnnamedVolumes((v) => !v)}
                  disabled={unnamedCount === 0}
                  title="Show or hide unnamed volumes"
                >
                  {showUnnamedVolumes ? "Hide unnamed" : `Show unnamed (${unnamedCount})`}
                </button>
                <button
                  type="button"
                  className="text-[11px] text-destructive hover:underline underline-offset-4 disabled:opacity-50 px-1"
                  disabled={clearableUnnamedCount === 0 || actionBusy}
                  title="Remove unnamed volumes not used by containers"
                  onClick={() => {
                    void doResourceAction("clear unnamed volumes", async () => {
                      for (const v of clearableUnnamedVolumes) {
                        await dockerClient.removeVolume(v.name);
                      }
                    }, {
                      refreshContainers: true,
                      refreshVolumes: true,
                    });
                  }}
                >
                  Clear{clearableUnnamedCount > 0 ? ` (${clearableUnnamedCount})` : ""}
                </button>
                <IconButton label="Refresh volumes" onClick={() => void refreshVolumes()}>
                  <RefreshCw className={`h-3 w-3 ${volumeLoading ? "animate-spin" : ""}`} />
                </IconButton>
              </div>
            )}
          </div>
          {volumeOpen && (
            <div className="flex-1 min-h-0 overflow-auto px-2 pb-2 space-y-1">
              {visibleVolumes.length === 0 && dockerAvailable !== false && !volumeLoading && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  {scopedVolumes.length > 0 && !showUnnamedVolumes
                    ? "No named volumes. Use “Show unnamed” to reveal anonymous volumes."
                    : (selectedComposeProject ? "No volumes found for selected app." : "No volumes found.")}
                </div>
              )}
              <ul className="space-y-1">
                {visibleVolumes.map((volume) => {
                  const displayName = isUnnamedVolumeName(volume.name) ? `Unnamed (${volume.name.slice(0, 12)})` : volume.name;
                  const isUsed = usedVolumeNames.has(volume.name);
                  const lowerName = volume.name.toLowerCase();
                  const isRootVolume = lowerName === DEFAULT_ROOT_VOLUME;
                  const isHomeVolume = lowerName === DEFAULT_HOME_VOLUME;
                  const menuId = `volume:${volume.name}`;
                  const volumeMenu = (
                    <>
                      {(isRootVolume || isHomeVolume) && (
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={() =>
                            void handleInstallBashDevToolsVolume(
                              volume.name,
                              isRootVolume ? "root" : "home",
                            )
                          }
                        >
                          Install bash dev tools
                        </button>
                      )}
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted mt-1 border-t pt-2"
                        onClick={() => {
                          closeMenu();
                          void doResourceAction("remove volume", () => dockerClient.removeVolume(volume.name), {
                            refreshContainers: false,
                            refreshVolumes: true,
                          });
                        }}
                      >
                        DELETE DOCKER VOLUME
                      </button>
                    </>
                  );
                  menuContentById.set(menuId, volumeMenu);
                  return (
                    <li
                      key={volume.name}
                      className="group rounded-md px-2 py-2 text-xs bg-muted/30 hover:bg-muted/60"
                      onContextMenu={(e) => openContextMenu(e, menuId)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 flex items-center gap-1.5">
                          <span className={`inline-block h-2 w-2 rounded-full ${isUsed ? "text-emerald-500" : "text-muted-foreground"} bg-current`} />
                          <span className="font-medium text-foreground truncate min-w-0 flex-1">{displayName}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {shouldShowResizeAfter("volume") && (
            <button
              type="button"
              aria-label="Resize Volumes section"
              className="h-1.5 w-full cursor-row-resize border-t border-border/50 bg-muted/20 hover:bg-muted/40"
              onPointerDown={(e) => startSectionResize(e, "volume")}
            />
          )}
        </div>

        {/* ── AI Models ── */}
        <div
          className="border-b flex flex-col min-h-0"
          style={{
            ...sectionStyle("aiModel", aiModelOpen),
            display: dockerSectionVisibility.aiModel ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("aiModel"))}>
            <button
              type="button"
              className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("aiModel")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${aiModelOpen ? "rotate-90" : ""}`} />
              <span>AI Models</span>
              {aiModels.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  ({visibleAiModels.length}/{aiModels.length})
                </span>
              )}
            </button>
            {aiModelOpen && (
              <div className="shrink min-w-0 flex items-center gap-1 pr-1">
                {configuredAiModelTypes.length > 0 && (
                  <div className="min-w-0 flex items-center gap-1 overflow-x-auto py-1">
                    {configuredAiModelTypes.map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-label={`Toggle ${MODEL_TYPE_DISPLAY[type]} models`}
                        title={MODEL_TYPE_DISPLAY[type]}
                        className={[
                          "shrink-0 rounded p-1.5",
                          selectedAiModelTypes.includes(type)
                            ? "bg-primary text-primary-foreground"
                            : "bg-secondary text-secondary-foreground hover:text-foreground hover:bg-secondary/80",
                        ].join(" ")}
                        onClick={() =>
                          setSelectedAiModelTypes((prev) =>
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
                <div title="Refresh AI models" onClick={() => void refreshAiModels()}>
                  <RefreshCw className={`h-3 w-3 ${aiModelLoading ? "animate-spin" : ""}`} />
                </div>
              </div>
            )}
          </div>
          {aiModelOpen && (
            <div className="flex-1 min-h-0 overflow-auto pb-2 space-y-1 bg-background">
              {/* ── Pull AI Model ── */}
              <div className="border-b px-2 pt-1 pb-2 space-y-1.5 bg-background">
                <div className="flex gap-1.5 px-1">
                  <input
                    ref={pullAiModelInputRef}
                    type="text"
                    className="flex-1 min-w-0 rounded border-input bg-background px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="e.g. ai/smollm2, ai/llama3.2"
                    value={pullAiModelInput}
                    onChange={(e) => setPullAiModelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && pullAiModelInput.trim()) {
                        onPullAiModel?.(pullAiModelInput.trim());
                        setPullAiModelInput("");
                        pullAiModelInputRef.current?.focus();
                      }
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Pull AI model"
                    title="Pull AI model"
                    className="shrink-0 rounded bg-secondary text-secondary-foreground px-2 py-1 text-xs font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={!pullAiModelInput.trim()}
                    onClick={() => {
                      if (!pullAiModelInput.trim()) return;
                      onPullAiModel?.(pullAiModelInput.trim());
                      setPullAiModelInput("");
                      pullAiModelInputRef.current?.focus();
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="px-2 space-y-1">
                {aiModels.length === 0 && dockerAvailable !== false && !aiModelLoading && (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No AI models found.
                  </div>
                )}
                {aiModels.length > 0 && visibleAiModels.length === 0 && (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No AI models match the selected model types.
                  </div>
                )}
                <ul className="space-y-1">
                  {sortedVisibleAiModels.map((model) => {
                    const isRunning = isAiModelRunning(model);
                    const modelTypes =
                      configuredAiModelTypesById.get(model.name.trim().toLowerCase()) ?? [];
                    const menuId = `ai-model:${model.name}`;
                    const aiModelMenu = (
                      <>
                        {isRunning && (
                          <button
                            type="button"
                            className="w-full px-2 py-1.5 border-b text-left text-xs hover:bg-muted"
                            onClick={() => {
                              closeMenu();
                              void doResourceAction("unload AI model", () => unloadAiModelAndWaitForState(model.name), {
                                refreshContainers: false,
                                refreshAiModels: true,
                              });
                            }}
                          >
                            Unload Docker Model
                          </button>
                        )}
                        <button
                          type="button"
                          className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                          onClick={() => {
                            closeMenu();
                            onRunAiModel?.(model.name);
                          }}
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
                            void doResourceAction("remove AI model", () => dockerClient.removeAiModel(model.name), {
                              refreshContainers: false,
                              refreshAiModels: true,
                            });
                          }}
                        >
                          DELETE DOCKER MODEL
                        </button>
                      </>
                    );
                    menuContentById.set(menuId, aiModelMenu);
                    return (
                      <li
                        key={model.name}
                        className="group rounded-md px-2 py-2 text-xs bg-muted/30 hover:bg-muted/60"
                        onContextMenu={(e) => openContextMenu(e, menuId)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-foreground truncate min-w-0 flex-1">
                            <span
                              className={`inline-block h-2 w-2 mr-1 rounded-full ${isRunning ? "text-emerald-500" : "text-muted-foreground"} bg-current`}
                            />
                            {formatDockerAiModelDisplayName(model.name)}
                            {(model.size) && (
                              <span className="ml-2 mt-1 truncate text-[10px] text-muted-foreground">
                                {model.size}
                              </span>
                            )}
                          </span>
                          {modelTypes.length > 0 && (
                            <span className="mt-1 flex gap-1">
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
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
          {shouldShowResizeAfter("aiModel") && (
            <button
              type="button"
              aria-label="Resize AI Models section"
              className="h-1.5 w-full cursor-row-resize border-t border-border/50 bg-muted/20 hover:bg-muted/40"
              onPointerDown={(e) => startSectionResize(e, "aiModel")}
            />
          )}
        </div>

        {/* ── Networks ── */}
        <div
          className="border-b flex flex-col min-h-0"
          style={{
            ...sectionStyle("network", networkOpen),
            display: dockerSectionVisibility.network ? undefined : "none",
          }}
        >
          <div className="flex items-center bg-background" onContextMenu={(e) => openContextMenu(e, sectionHeaderMenuId("network"))}>
            <button
              type="button"
              className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
              onClick={() => toggleSection("network")}
            >
              <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${networkOpen ? "rotate-90" : ""}`} />
              <span>Networks</span>
              {visibleNetworks.length > 0 && (
                <span className="text-[10px] text-muted-foreground">({visibleNetworks.length})</span>
              )}
            </button>
            {networkOpen && (
              <div className="shrink-0 flex items-center gap-1 pr-1">
                <IconButton label="Refresh networks" onClick={() => void refreshNetworks()}>
                  <RefreshCw className={`h-3 w-3 ${networkLoading ? "animate-spin" : ""}`} />
                </IconButton>
              </div>
            )}
          </div>
          {networkOpen && (
            <div className="flex-1 min-h-0 overflow-auto px-2 pb-2 space-y-1">
              {visibleNetworks.length === 0 && dockerAvailable !== false && !networkLoading && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  {selectedComposeProject ? "No networks found for selected app." : "No networks found."}
                </div>
              )}
              <ul className="space-y-1">
                {visibleNetworks.map((network) => {
                  const isRunning = runningNetworks.has(network.name);
                  const isUsed = usedNetworks.has(network.name);
                  const menuId = `network:${network.name}`;
                  const networkMenu = (
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted"
                      disabled={network.name === "bridge" || network.name === "host" || network.name === "none"}
                      onClick={() => {
                        closeMenu();
                        void doResourceAction("remove network", () => dockerClient.removeNetwork(network.name), {
                          refreshContainers: false,
                          refreshNetworks: true,
                        });
                      }}
                    >
                      Remove network
                    </button>
                  );
                  menuContentById.set(menuId, networkMenu);
                  return (
                    <li
                      key={network.name}
                      className="group rounded-md px-2 py-2 text-xs bg-muted/30 hover:bg-muted/60"
                      onContextMenu={(e) => openContextMenu(e, menuId)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1 flex items-center gap-1.5">
                          <span
                            className={`inline-block h-2 w-2 rounded-full ${isRunning ? "text-emerald-500" : isUsed ? "text-amber-400" : "text-muted-foreground"} bg-current`}
                          />
                          <span className="font-medium text-foreground truncate min-w-0 flex-1">{network.name}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>

      {openMenu && typeof document !== "undefined" && createPortal(
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

      {/* ── Modals ── */}

      {/* Writable warning tooltip (portal so it's not clipped by panels) */}
      {writableWarningTooltip && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] w-[340px] rounded-md border bg-background p-2 text-[11px] leading-relaxed text-muted-foreground shadow-2xl"
          style={{ left: writableWarningTooltip.left, top: writableWarningTooltip.top }}
        >
          <div className="font-medium text-foreground">
            This container is writable (not read-only).
          </div>
          <div className="mt-1">
            Writable containers are higher risk and shouldn’t be used as development containers (especially if you plan to connect AI agents).
          </div>
          <div className="mt-2 font-medium text-foreground">Recommended flow</div>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            <li>Start from a hardened/trusted Docker image (ideally one you build).</li>
            <li>Keep containers read-only when possible.</li>
            <li>Install bash dev tools into `root` / `home` volumes from the Volumes menu.</li>
          </ul>
        </div>,
        document.body,
      )}

      {/* Write mode warning modal */}
      {writeModeWarningOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-white/15 p-4">
          <button
            type="button"
            className="absolute inset-0"
            onClick={() => { setWriteModeWarningOpen(false); setWriteModeTargetId(null); }}
          />
          <div className="relative z-[81] w-full max-w-lg rounded-md border bg-background p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-foreground">
                Switch container to write mode?
              </div>
              <IconButton
                label="Close"
                onClick={() => { setWriteModeWarningOpen(false); setWriteModeTargetId(null); }}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>

            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="text-foreground">
                Relaunching a read-only container with a writable root filesystem can be a security risk.
              </div>
              <div>
                Only do this if you trust the development image you’re using. Ideally, create the image yourself from trusted sources.
              </div>
              <div>
                This will update <span className="font-medium text-foreground">Read-only root filesystem</span> to off and then <span className="font-medium text-foreground">Save &amp; Relaunch</span>.
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                onClick={() => { setWriteModeWarningOpen(false); setWriteModeTargetId(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-primary bg-primary/15 px-3 py-1.5 text-xs text-primary disabled:opacity-50"
                disabled={createBusy}
                onClick={() => void confirmWriteMode()}
              >
                I understand — relaunch in write mode
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create container modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-white/15 p-4">
          <button
            type="button"
            className="absolute inset-0"
            onClick={() => {
              if (createBusy) return;
              setShowCreateModal(false);
              setEditingContainerOriginalCommand("");
            }}
          />
          <div className="relative z-[71] flex w-full max-w-lg max-h-[85vh] flex-col overflow-hidden rounded-md border bg-background p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-foreground">
                {form.editingContainerId ? "Edit Container" : "Create Container"}
              </div>
              <IconButton
                label="Close"
                onClick={() => {
                  if (createBusy) return;
                  setShowCreateModal(false);
                  setEditingContainerOriginalCommand("");
                }}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>

            {createError && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {createError}
              </div>
            )}

            <div className="space-y-3 overflow-y-auto pr-1">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Image *</span>
                <input
                  type="text"
                  list="docker-images-datalist"
                  placeholder="e.g. node:20, python:3.12, ubuntu:24.04"
                  className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                  value={form.image}
                  onChange={(e) => setForm((prev) => ({ ...prev, image: e.target.value }))}
                />
                <datalist id="docker-images-datalist">
                  {sortedImages.map((img) => {
                    const label = img.tag && img.tag !== "<none>"
                      ? `${img.repository}:${img.tag}`
                      : img.repository;
                    return label !== "<none>" ? (
                      <option key={`${img.id}-${img.tag}`} value={label} />
                    ) : null;
                  })}
                </datalist>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Container name (optional)</span>
                <input
                  type="text"
                  placeholder={deriveContainerName(form.image) || "my-dev-env"}
                  className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">User</span>
                <CustomSelect
                  value={form.user}
                  onChange={(v) => setForm((prev) => ({ ...prev, user: v }))}
                  options={[
                    { value: "auto", label: "Auto (image default / best guess)" },
                    { value: "root", label: "root" },
                    ...formImageUsers
                      .filter((u) => u && u !== "root")
                      .map((u) => ({ value: u, label: u })),
                  ]}
                  className="rounded-md px-2 py-2 text-sm"
                />
                <span className="text-[10px] text-muted-foreground">
                  Sets the container process (PID 1) and terminal sessions{formImageUsersBusy ? " — loading…" : ""}{formImageUsersError ? " — " + formImageUsersError : ""}
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Attached Volumes</span>
                {(() => {
                  const available = volumes
                    .filter((v) => !isUnnamedVolumeName(v.name))
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name));

                  const existingPaths = (form.attachedVolumes ?? [])
                    .map((m) => m.containerPath)
                    .filter(Boolean)
                    .filter((p) => p !== "/tmp");
                  const declaredSource =
                    formImageDeclaredVolumePaths.length > 0 ? formImageDeclaredVolumePaths : activeImageDeclaredVolumePaths;
                  const declared = declaredSource
                    .filter((p) => p && p !== "/workspace" && !isReservedMountPath(p));

                  const fixed = ["/workspace", "/root", "/home"];
                  const fixedSet = new Set(fixed);
                  const declaredSet = new Set(declared);
                  const paths = Array.from(new Set([...fixed, ...declared])).sort((a, b) => {
                    // Keep Project/Home/Tmp at the top in a stable order.
                    const order = new Map<string, number>([
                      ["/workspace", 0],
                      ["/root", 1],
                      ["/home", 2],
                    ]);
                    const ao = order.get(a);
                    const bo = order.get(b);
                    if (ao !== undefined || bo !== undefined) return (ao ?? 99) - (bo ?? 99);
                    return a.localeCompare(b);
                  });
                  const userDefinedPaths = Array.from(
                    new Set([
                      ...(form.userDefinedVolumePaths ?? []),
                      ...existingPaths.filter((p) => !fixedSet.has(p) && !declaredSet.has(p)),
                    ]),
                  ).filter((p) => p && p !== "/workspace" && !isReservedMountPath(p) && !declaredSet.has(p));

                  const byPath = new Map((form.attachedVolumes ?? []).map((m) => [m.containerPath, m.volume]));

                  const setPathVolume = (containerPath: string, volume: string) => {
                    setForm((prev) => {
                      const kept = (prev.attachedVolumes ?? []).filter((m) => m.containerPath !== containerPath);
                      if (volume) kept.push({ containerPath, volume });
                      return { ...prev, attachedVolumes: kept };
                    });
                  };
                  const addUserDefinedPath = () => {
                    setForm((prev) => {
                      const existing = new Set([
                        ...(prev.userDefinedVolumePaths ?? []),
                        ...((prev.attachedVolumes ?? []).map((m) => m.containerPath)),
                      ]);
                      let idx = 1;
                      let candidate = `/mnt/volume-${idx}`;
                      while (existing.has(candidate)) {
                        idx += 1;
                        candidate = `/mnt/volume-${idx}`;
                      }
                      return {
                        ...prev,
                        userDefinedVolumePaths: [...(prev.userDefinedVolumePaths ?? []), candidate],
                      };
                    });
                  };
                  const updateUserDefinedPath = (oldPath: string, nextPath: string) => {
                    setForm((prev) => {
                      const prevPaths = [...(prev.userDefinedVolumePaths ?? [])];
                      const existingIndex = prevPaths.indexOf(oldPath);
                      if (existingIndex >= 0) {
                        prevPaths[existingIndex] = nextPath;
                      } else if (nextPath.trim()) {
                        prevPaths.push(nextPath);
                      }
                      let nextAttached = [...(prev.attachedVolumes ?? [])];
                      if (oldPath !== nextPath) {
                        const moved = nextAttached.find((m) => m.containerPath === oldPath);
                        nextAttached = nextAttached.filter((m) => m.containerPath !== oldPath);
                        if (moved && nextPath.trim()) {
                          nextAttached = [
                            ...nextAttached.filter((m) => m.containerPath !== nextPath.trim()),
                            { ...moved, containerPath: nextPath.trim() },
                          ];
                        }
                      }
                      return {
                        ...prev,
                        userDefinedVolumePaths: prevPaths,
                        attachedVolumes: nextAttached,
                      };
                    });
                  };
                  const removeUserDefinedPath = (path: string) => {
                    setForm((prev) => ({
                      ...prev,
                      userDefinedVolumePaths: (prev.userDefinedVolumePaths ?? []).filter((p) => p !== path),
                      attachedVolumes: (prev.attachedVolumes ?? []).filter((m) => m.containerPath !== path),
                    }));
                  };

                  return (
                    <div className="rounded-md border bg-muted/10 p-2 space-y-2">
                      {paths.map((containerPath) => {
                        const current = byPath.get(containerPath) ?? "";
                        const isWorkspace = containerPath === "/workspace";
                        const isRoot = containerPath === "/root";
                        const isHome = containerPath === "/home";
                        const optionNames = (() => {
                          const names = new Set<string>(available.map((v) => v.name));
                          if (current) names.add(current);
                          if (isRoot) names.add(DEFAULT_ROOT_VOLUME);
                          if (isHome) names.add(DEFAULT_HOME_VOLUME);
                          return Array.from(names).sort((a, b) => a.localeCompare(b));
                        })();
                        return (
                          <div key={containerPath} className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] text-foreground">
                                {isWorkspace ? "Project" : isRoot ? "Root" : isHome ? "Home" : "Volume"}
                                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                  {containerPath}
                                </span>
                              </div>
                            </div>
                            <CustomSelect
                              value={current}
                              onChange={(v) => setPathVolume(containerPath, v)}
                              options={[
                                { value: "", label: "None" },
                                ...optionNames.map((name) => ({ value: name, label: name })),
                              ]}
                              className="shrink-0 w-56 rounded-md px-2 py-1.5 text-xs"
                            />
                          </div>
                        );
                      })}
                      {userDefinedPaths.map((containerPath, index) => {
                        const current = byPath.get(containerPath) ?? "";
                        const optionNames = (() => {
                          const names = new Set<string>(available.map((v) => v.name));
                          if (current) names.add(current);
                          return Array.from(names).sort((a, b) => a.localeCompare(b));
                        })();
                        return (
                          <div key={index} className="flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="/mnt/custom"
                              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-xs text-foreground"
                              value={containerPath}
                              onChange={(e) => updateUserDefinedPath(containerPath, e.target.value)}
                            />
                            <CustomSelect
                              value={current}
                              onChange={(v) => setPathVolume(containerPath, v)}
                              options={[
                                { value: "", label: "None" },
                                ...optionNames.map((name) => ({ value: name, label: name })),
                              ]}
                              disabled={!containerPath.trim()}
                              className="shrink-0 w-56 rounded-md px-2 py-1.5 text-xs"
                            />
                            <button
                              type="button"
                              className="shrink-0 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted"
                              onClick={() => removeUserDefinedPath(containerPath)}
                              aria-label={`Remove mount ${containerPath}`}
                              title="Remove user-defined mount"
                            >
                              -
                            </button>
                          </div>
                        );
                      })}
                      <div className="pt-1">
                        <button
                          type="button"
                          className="rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted"
                          onClick={addUserDefinedPath}
                        >
                          +
                        </button>
                      </div>
                      {paths.length === 0 && userDefinedPaths.length === 0 && (
                        <div className="text-xs text-muted-foreground italic">No attachable volume paths found.</div>
                      )}
                    </div>
                  );
                })()}
              </label>


              {/* Advanced section */}
              <div className="space-y-3 pl-2 border-l-2 border-muted">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Environment variables (KEY=VALUE, one per line)</span>
                  <textarea
                    rows={3}
                    placeholder={"NODE_ENV=development\nPORT=3000"}
                    className="rounded-md border bg-background px-2 py-2 text-sm text-foreground font-mono"
                    value={form.envVars}
                    onChange={(e) => setForm((prev) => ({ ...prev, envVars: e.target.value }))}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Command override</span>
                    {(() => {
                      const original = form.editingContainerId ? editingContainerOriginalCommand.trim() : "";
                      const suggestions = Array.from(
                        new Set([original, "sleep infinity", "tail -f /dev/null"].filter(Boolean)),
                      );
                      return (
                        <>
                          <input
                            type="text"
                            placeholder="e.g. sleep infinity"
                            className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                            value={form.command}
                            list="command-override-datalist"
                            onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
                          />
                          <datalist id="command-override-datalist">
                            {suggestions.map((v) => (
                              <option key={v} value={v} />
                            ))}
                          </datalist>
                        </>
                      );
                    })()}
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Command Workdir</span>
                    <input
                      type="text"
                      placeholder="Leave blank to use the image default"
                      className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                      value={form.commandWorkdir}
                      onChange={(e) => setForm((prev) => ({ ...prev, commandWorkdir: e.target.value }))}
                    />
                  </label>
                  <div className="col-span-2 flex flex-col gap-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Container shells</span>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            containerShells: [...prev.containerShells, createEmptyContainerShell()],
                          }))}
                      >
                        <Plus className="h-3 w-3" />
                        Add shell
                      </button>
                    </div>
                    <div className="space-y-2">
                      {form.containerShells.map((shell, index) => (
                        <div
                          key={index}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2"
                        >
                          <input
                            type="text"
                            placeholder="Name"
                            className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                            value={shell.name}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                containerShells: prev.containerShells.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, name: e.target.value } : entry
                                ),
                              }))}
                          />
                          <input
                            type="text"
                            placeholder="Command"
                            list="container-shell-command-datalist"
                            className="rounded-md border bg-background px-2 py-2 text-sm text-foreground font-mono"
                            value={shell.command}
                            onChange={(e) =>
                              setForm((prev) => ({
                                ...prev,
                                containerShells: prev.containerShells.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, command: e.target.value } : entry
                                ),
                              }))}
                          />
                          <button
                            type="button"
                            aria-label={`Remove container shell ${index + 1}`}
                            className="rounded border px-2 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={form.containerShells.length === 0}
                            onClick={() =>
                              setForm((prev) => ({
                                ...prev,
                                containerShells: prev.containerShells.filter((_, entryIndex) => entryIndex !== index),
                              }))}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      {form.containerShells.length === 0 && (
                        <div className="rounded-md border border-dashed px-2 py-2 text-[11px] text-muted-foreground">
                          No container shells configured. This container will be treated as a service with no exec shell.
                        </div>
                      )}
                    </div>
                    <datalist id="container-shell-command-datalist">
                      {SUGGESTED_CONTAINER_SHELL_COMMANDS.map((command) => (
                        <option key={command} value={command} />
                      ))}
                    </datalist>
                  </div>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Exec Shell Workdir</span>
                    <input
                      type="text"
                      placeholder="Leave blank to use the container default"
                      className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                      value={form.execShellWorkdir}
                      onChange={(e) => setForm((prev) => ({ ...prev, execShellWorkdir: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">Memory limit</span>
                    <input
                      type="text"
                      placeholder="e.g. 512m, 2g"
                      className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                      value={form.memoryLimit}
                      onChange={(e) => setForm((prev) => ({ ...prev, memoryLimit: e.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">CPU limit</span>
                    <input
                      type="text"
                      placeholder="e.g. 1.5"
                      className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                      value={form.cpuLimit}
                      onChange={(e) => setForm((prev) => ({ ...prev, cpuLimit: e.target.value }))}
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    Port mappings (host:container, comma-separated)
                  </span>
                  <input
                    type="text"
                    placeholder="8080:80, 3000:3000"
                    className={`rounded-md border bg-background px-2 py-2 text-sm text-foreground ${form.netHost ? "opacity-50" : ""}`}
                    value={form.ports}
                    disabled={form.netHost}
                    onChange={(e) => setForm((prev) => ({ ...prev, ports: e.target.value }))}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.readOnly}
                    onChange={(e) => setForm((prev) => ({ ...prev, readOnly: e.target.checked }))}
                  />
                  <span className="text-muted-foreground">Read-only root filesystem</span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.tmpfsTmp}
                    onChange={(e) => setForm((prev) => ({ ...prev, tmpfsTmp: e.target.checked }))}
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    Temporary file system
                    <span className="ml-1 text-[10px] opacity-70">
                      — mounts tmpfs at <span className="font-mono">/tmp</span> (<span className="font-mono">--tmpfs /tmp:rw</span>)
                    </span>
                  </span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.netHost}
                    onChange={(e) => setForm((prev) => ({ ...prev, netHost: e.target.checked }))}
                  />
                  <span className="text-muted-foreground">Host networking (--net=host)</span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.mountDockerSocket}
                    onChange={(e) => setForm((prev) => ({ ...prev, mountDockerSocket: e.target.checked }))}
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    Docker-outside-of-Docker (mount Docker socket)
                  </span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.gpusAll}
                    onChange={(e) => setForm((prev) => ({ ...prev, gpusAll: e.target.checked }))}
                  />
                  <span className="text-muted-foreground">GPU access (--gpus=all)</span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.sshAgent}
                    onChange={(e) => setForm((prev) => ({ ...prev, sshAgent: e.target.checked }))}
                  />
                  <span className="text-muted-foreground">
                    SSH agent forwarding
                    <span className="ml-1 text-[10px] opacity-70">
                      — forwards host SSH keys for git operations
                    </span>
                  </span>
                </label>
                {form.sshAgent && (
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      SSH agent host socket path (advanced)
                    </span>
                    <input
                      type="text"
                      placeholder={hasRemoteDockerHost ? "/path/on/remote/host/agent.sock" : "auto-detected"}
                      className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                      value={form.sshAgentHostSocketPath}
                      onChange={(e) => setForm((prev) => ({ ...prev, sshAgentHostSocketPath: e.target.value }))}
                    />
                    <span className="text-[10px] text-muted-foreground opacity-80">
                      {hasRemoteDockerHost
                        ? "Resolved on the remote Docker host; leave blank to use daemon defaults."
                        : "Leave blank to auto-detect local defaults."}
                    </span>
                  </label>
                )}
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.gitConfig}
                    onChange={(e) => setForm((prev) => ({ ...prev, gitConfig: e.target.checked }))}
                  />
                  <span className="text-muted-foreground">
                    Bind host .gitconfig
                    <span className="ml-1 text-[10px] opacity-70">
                      — mounts <span className="font-mono">~/.gitconfig</span> into the container for git identity/settings
                    </span>
                  </span>
                </label>
                {form.gitConfig && (
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      Gitconfig host path (advanced)
                    </span>
                    <input
                      type="text"
                      placeholder={hasRemoteDockerHost ? "/home/user/.gitconfig" : "~/.gitconfig"}
                      className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                      value={form.gitConfigHostPath}
                      onChange={(e) => setForm((prev) => ({ ...prev, gitConfigHostPath: e.target.value }))}
                    />
                    <span className="text-[10px] text-muted-foreground opacity-80">
                      {hasRemoteDockerHost
                        ? "Resolved on the remote Docker host; leave blank to use default ~/.gitconfig."
                        : "Leave blank to use local ~/.gitconfig."}
                    </span>
                  </label>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              {(() => {
                const currentState = form.editingContainerId
                  ? containers.find((c) => c.id === form.editingContainerId)?.state
                  : null;
                const isRunningNow = currentState === "running";
                const editingStopped = Boolean(form.editingContainerId) && (currentState ? !isRunningNow : !form.editingContainerWasRunning);
                return (
                  <>
                    <button
                      type="button"
                      className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                      disabled={createBusy}
                      onClick={() => { setShowCreateModal(false); setEditingContainerOriginalCommand(""); }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-primary bg-primary/15 px-3 py-1.5 text-xs text-primary disabled:opacity-50"
                      disabled={createBusy || !form.image.trim()}
                      onClick={() => void handleCreate(undefined, editingStopped ? { autoStart: false } : undefined)}
                    >
                      {createBusy ? (
                        <span className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {form.editingContainerId ? (editingStopped ? "Saving..." : "Relaunching...") : "Creating..."}
                        </span>
                      ) : form.editingContainerId ? (
                        editingStopped ? "Save" : "Save & Relaunch"
                      ) : (
                        "Create & Start"
                      )}
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
