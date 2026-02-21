import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileMusic,
  FileText,
  FileVideo2,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useInAppDialogs } from "../context/InAppDialogsContext";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import type { ContainerInspect, FileEntry } from "../electrobun/rpcSchema";
import { readJSON, writeJSON, getItem, setItem, removeItem } from "../lib/localStorage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  /** Dedicated container used for file operations (alpine/git). */
  fileOpsContainerId: string | null;
  onOpenFileTemporary: (filePath: string) => boolean;
  onOpenFileEdit: (filePath: string) => boolean;
  refreshNonce: number;
  onRefresh: () => void;
  revealRequest: {
    nonce: number;
    path: string;
    kind: "file" | "directory";
  } | null;
};

type TreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo?: boolean;
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
};

type FileRootConfig = {
  id: "root" | "workspace" | "home" | "tmp";
  title: string;
  rootPath: string;
  emptyMessage: string;
};

const FILES_OPEN_SECTIONS_KEY = "context-assistant.files.open-sections.v1";
const FILES_SECTION_WEIGHTS_KEY = "context-assistant.files.section-weights.v1";
const FILES_WORKSPACE_PROJECT_ROOT_KEY = "context-assistant.files.workspace-project-root.v1";

const FILE_ROOTS: FileRootConfig[] = [
  {
    id: "workspace",
    title: "Workspace",
    rootPath: "/workspace",
    emptyMessage: "No files in /workspace. Create files or attach a volume.",
  },
  {
    id: "home",
    title: "Home",
    // NOTE: The real home root is container-dependent (e.g. /root for root-user).
    // This is overridden at runtime in <VolumeView />.
    rootPath: "/home",
    emptyMessage: "No files in home.",
  },
  {
    id: "root",
    title: "Root",
    rootPath: "/",
    emptyMessage: "No files in /.",
  },
  {
    id: "tmp",
    title: "Tmp",
    rootPath: "/tmp",
    emptyMessage: "No files in /tmp.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEVCONTAINER_HOME_VOLUME = "home";
const DEVCONTAINER_ROOT_VOLUME = "root";

function isContainerNotRunningError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const lower = msg.toLowerCase();
  return (
    lower.includes("is not running") ||
    lower.includes("unable to upgrade to tcp, received 409") ||
    lower.includes("container is restarting")
  );
}

async function ensureContainerRunning(containerId: string): Promise<void> {
  try {
    const inspect = await dockerClient.inspectContainer(containerId);
    if (inspect.state.running) return;
  } catch {
    // ignore — fall through to try start
  }
  try {
    await dockerClient.startContainer(containerId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    if (!msg.toLowerCase().includes("already running")) throw e;
  }
}

async function listFilesSafe(containerId: string, path: string): Promise<FileEntry[]> {
  try {
    return await dockerClient.listFiles(containerId, path);
  } catch (e) {
    if (!isContainerNotRunningError(e)) throw e;
    await ensureContainerRunning(containerId);
    return await dockerClient.listFiles(containerId, path);
  }
}

function getHomeRootFromInspect(inspect: ContainerInspect): string {
  const rootUserLabel = inspect.config.labels?.["context-assistant.root-user"];
  const isRootUser = rootUserLabel !== "false";
  const execUserLabel = (inspect.config.labels?.["context-assistant.exec-user"] ?? "").trim();
  const configuredUser = (inspect.config.user ?? "").trim();
  const user = execUserLabel || configuredUser || (isRootUser ? "root" : "auto");

  const rootMount = inspect.mounts.find(
    (m) =>
      m.name === DEVCONTAINER_ROOT_VOLUME ||
      m.destination === "/root" ||
      m.destination.startsWith("/root/"),
  );

  const homeMount = inspect.mounts.find(
    (m) =>
      m.name === DEVCONTAINER_HOME_VOLUME ||
      m.destination === "/home" ||
      m.destination.startsWith("/home/"),
  );

  const isRoot = user === "root" || user === "0";
  if (isRoot) {
    if (rootMount?.destination) return "/root";
    // Legacy "home" volume could have been mounted to /root.
    const legacyRoot = inspect.mounts.find((m) => m.destination === "/root" || m.destination.startsWith("/root/"));
    if (legacyRoot?.destination) return "/root";
    return "/root";
  }

  // Non-root user
  if (homeMount?.destination?.startsWith("/home/")) {
    // Legacy: home volume mounted directly to /home/<user>
    return homeMount.destination;
  }

  if (user && user !== "auto") {
    // New model: /home is mounted, so the effective home directory is inside it.
    return `/home/${user}`;
  }

  // Fallback for "auto"
  return "/home";
}

const getFileExtension = (name: string) => {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
};

const CODE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "cc", "cs", "php", "sh", "bash", "zsh",
  "html", "htm", "css", "scss",
  "atom", "rdf", "rss", "xht", "xhtml", "xml", "jsonl", "jsonld", "jsonc", "geojson", "webmanifest",
]);
const CONFIG_EXTENSIONS = new Set(["yaml", "yml", "toml", "xml", "ini", "env"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const VIDEO_EXTENSIONS = new Set(["avi", "mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "aac", "opus", "flac"]);
const MODEL_3D_EXTENSIONS = new Set(["glb", "gltf", "usdz", "obj", "stl", "ply", "fbx"]);

const iconStyle = (varName: string) => ({ color: `var(${varName})` });

const fileIcon = (name: string) => {
  const ext = getFileExtension(name);
  if (ext === "json" || ext === "jsonc") return <FileJson2 className="h-3.5 w-3.5" style={iconStyle("--file-browser-json")} />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode2 className="h-3.5 w-3.5" style={iconStyle("--file-browser-code")} />;
  if (CONFIG_EXTENSIONS.has(ext)) return <FileCog className="h-3.5 w-3.5" style={iconStyle("--file-browser-config")} />;
  if (ext === "md" || ext === "markdown") return <FileText className="h-3.5 w-3.5" style={iconStyle("--file-browser-markdown")} />;
  if (IMAGE_EXTENSIONS.has(ext))
    return <FileImage className="h-3.5 w-3.5" style={iconStyle("--file-browser-image")} />;
  if (VIDEO_EXTENSIONS.has(ext)) return <FileVideo2 className="h-3.5 w-3.5" style={iconStyle("--file-browser-video")} />;
  if (AUDIO_EXTENSIONS.has(ext)) return <FileMusic className="h-3.5 w-3.5" style={iconStyle("--file-browser-audio")} />;
  if (MODEL_3D_EXTENSIONS.has(ext)) return <Box className="h-3.5 w-3.5" style={iconStyle("--file-browser-model3d")} />;
  return <File className="h-3.5 w-3.5" style={iconStyle("--file-browser-default")} />;
};

type FileRootSectionProps = {
  id: FileRootConfig["id"];
  title: string;
  rootPath: string;
  emptyMessage: string;
  open: boolean;
  flexGrow?: number;
  showResizeHandle?: boolean;
  onResizeHandlePointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  refreshNonce: number;
  fileOpsContainerId: string | null;
  onToggle: () => void;
  onRefresh: () => void;
  onOpenFileTemporary: (filePath: string) => boolean;
  onOpenFileEdit: (filePath: string) => boolean;
  revealRequest: Props["revealRequest"];
  workspaceRootPath?: string;
  workspaceProjectRoot?: string | null;
  onSelectWorkspaceProjectRoot?: (rootPath: string) => void;
  onClearWorkspaceProjectRoot?: () => void;
};

function normalizeAbsolutePath(path: string): string {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized.length > 0 ? normalized : "/";
}

function pathWithinRoot(rootPath: string, path: string): boolean {
  const root = normalizeAbsolutePath(rootPath);
  const target = normalizeAbsolutePath(path);
  if (target === root) return true;
  return target.startsWith(`${root}/`);
}

function updateNodeByPath(
  nodes: TreeNode[],
  path: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === path) return updater(node);
    if (node.children) return { ...node, children: updateNodeByPath(node.children, path, updater) };
    return node;
  });
}

function findNodeByPath(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const child = findNodeByPath(node.children, path);
      if (child) return child;
    }
  }
  return null;
}

function indexTree(nodes: TreeNode[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      map.set(node.path, node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return map;
}

function mergeTreeState(prev: TreeNode[], next: TreeNode[]): TreeNode[] {
  if (prev.length === 0) return next;
  const prevIndex = indexTree(prev);
  return next.map((node) => {
    const prevNode = prevIndex.get(node.path);
    if (!prevNode || !node.isDirectory) return node;
    return {
      ...node,
      isGitRepo: prevNode.isGitRepo ?? node.isGitRepo,
      expanded: prevNode.expanded,
      children: prevNode.children ?? node.children,
      loading: false,
    };
  });
}

function FileRootSection({
  id,
  title,
  rootPath,
  emptyMessage,
  open,
  flexGrow,
  showResizeHandle,
  onResizeHandlePointerDown,
  refreshNonce,
  fileOpsContainerId,
  onToggle,
  onRefresh,
  onOpenFileTemporary,
  onOpenFileEdit,
  revealRequest,
  workspaceRootPath,
  workspaceProjectRoot,
  onSelectWorkspaceProjectRoot,
  onClearWorkspaceProjectRoot,
}: FileRootSectionProps) {
  const CONTEXT_MENU_MARGIN = 8;
  const CONTEXT_MENU_ESTIMATED_WIDTH = 200;
  const CONTEXT_MENU_ESTIMATED_HEIGHT = 220;
  const { askPrompt } = useInAppDialogs();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [clearTmpConfirmOpen, setClearTmpConfirmOpen] = useState(false);
  const [rootIsGitRepo, setRootIsGitRepo] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    anchorX: number;
    anchorY: number;
    node: TreeNode;
  } | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const clampContextMenuPosition = useCallback(
    (x: number, y: number, menuWidth: number, menuHeight: number) => {
      if (typeof window === "undefined") return { x, y };
      const maxX = Math.max(
        CONTEXT_MENU_MARGIN,
        window.innerWidth - CONTEXT_MENU_MARGIN - Math.max(0, menuWidth),
      );
      const maxY = Math.max(
        CONTEXT_MENU_MARGIN,
        window.innerHeight - CONTEXT_MENU_MARGIN - Math.max(0, menuHeight),
      );
      return {
        x: Math.min(Math.max(x, CONTEXT_MENU_MARGIN), maxX),
        y: Math.min(Math.max(y, CONTEXT_MENU_MARGIN), maxY),
      };
    },
    [CONTEXT_MENU_MARGIN],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const recalc = () => {
      const rect = contextMenuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clamped = clampContextMenuPosition(contextMenu.anchorX, contextMenu.anchorY, rect.width, rect.height);
      if (clamped.x !== contextMenu.x || clamped.y !== contextMenu.y) {
        setContextMenu((prev) => (prev ? { ...prev, x: clamped.x, y: clamped.y } : prev));
      }
    };
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, [clampContextMenuPosition, contextMenu]);

  const entriesToNodes = useCallback(
    (basePath: string, entries: FileEntry[]): TreeNode[] => {
      const nodes: TreeNode[] = entries
        // Hide git internals from the file browser.
        .filter((entry) => entry.name !== ".git")
        .map((entry) => ({
          name: entry.name,
          path: `${basePath}/${entry.name}`,
          isDirectory: entry.isDirectory,
          isGitRepo: false,
          expanded: false,
          children: entry.isDirectory ? [] : undefined,
        }));
      nodes.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return nodes;
    },
    [],
  );

  const loadTree = useCallback(async () => {
    if (!fileOpsContainerId) {
      setTree([]);
      setRootIsGitRepo(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const entries = await listFilesSafe(fileOpsContainerId, rootPath);
      setRootIsGitRepo(entries.some((e) => e.name === ".git"));
      const nodes = entriesToNodes(rootPath, entries);
      setTree((prev) => mergeTreeState(prev, nodes));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to list files";
      if (msg.includes("No such file or directory")) {
        setTree([]);
        setRootIsGitRepo(false);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [fileOpsContainerId, rootPath, entriesToNodes]);

  useEffect(() => {
    if (!open) return;
    void loadTree();
  }, [loadTree, refreshNonce, open]);

  const refreshDirectoryListing = useCallback(
    async (dirPath: string) => {
      if (!fileOpsContainerId) return;

      // Root listing (top-level items under rootPath) has no node to attach children to.
      if (dirPath === rootPath) {
        await loadTree();
        return;
      }

      const markDirLoading = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.path === dirPath && node.isDirectory) {
            return { ...node, loading: true };
          }
          if (node.children) return { ...node, children: markDirLoading(node.children) };
          return node;
        });
      setTree(markDirLoading);

      try {
        const entries = await listFilesSafe(fileOpsContainerId, dirPath);
        const hasGit = entries.some((e) => e.name === ".git");
        const nextChildren = entriesToNodes(dirPath, entries);

        const updateChildren = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((node) => {
            if (node.path === dirPath && node.isDirectory) {
              return {
                ...node,
                isGitRepo: hasGit,
                children: mergeTreeState(node.children ?? [], nextChildren),
                loading: false,
              };
            }
            if (node.children) return { ...node, children: updateChildren(node.children) };
            return node;
          });
        setTree(updateChildren);
      } catch {
        const clearLoading = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((node) => {
            if (node.path === dirPath) return { ...node, loading: false };
            if (node.children) return { ...node, children: clearLoading(node.children) };
            return node;
          });
        setTree(clearLoading);
      }
    },
    [fileOpsContainerId, rootPath, loadTree, entriesToNodes],
  );

  const parentDir = useCallback((path: string) => {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 1) return "/";
    return `/${parts.slice(0, -1).join("/")}`;
  }, []);

  const toggleExpand = useCallback(
    async (path: string, currentlyExpanded: boolean) => {
      if (!fileOpsContainerId) return;

      if (currentlyExpanded) {
        const collapseNode = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((node) => {
            if (node.path === path) return { ...node, expanded: false };
            if (node.children) return { ...node, children: collapseNode(node.children) };
            return node;
          });
        setTree(collapseNode);
        return;
      }

      const markExpanding = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.path === path && node.isDirectory) {
            return { ...node, expanded: true, loading: true };
          }
          if (node.children) {
            return { ...node, children: markExpanding(node.children) };
          }
          return node;
        });
      setTree(markExpanding);

      try {
        const entries = await listFilesSafe(fileOpsContainerId, path);
        const hasGit = entries.some((e) => e.name === ".git");
        const children = entriesToNodes(path, entries);

        const insertChildren = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((node) => {
            if (node.path === path) {
              return { ...node, isGitRepo: hasGit, children, loading: false, expanded: true };
            }
            if (node.children) {
              return { ...node, children: insertChildren(node.children) };
            }
            return node;
          });

        setTree((prev) => insertChildren(prev));
      } catch {
        const clearLoading = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((node) => {
            if (node.path === path) return { ...node, loading: false, expanded: false };
            if (node.children) return { ...node, children: clearLoading(node.children) };
            return node;
          });
        setTree((prev) => clearLoading(prev));
      }
    },
    [fileOpsContainerId, entriesToNodes],
  );

  const revealPath = useCallback(
    async (targetPath: string, targetKind: "file" | "directory") => {
      if (!fileOpsContainerId) return;
      const normalizedRoot = normalizeAbsolutePath(rootPath);
      const normalizedTarget = normalizeAbsolutePath(targetPath);
      if (!pathWithinRoot(normalizedRoot, normalizedTarget)) return;

      setLoading(true);
      setError(null);

      try {
        const rootEntries = await listFilesSafe(fileOpsContainerId, normalizedRoot);
        setRootIsGitRepo(rootEntries.some((entry) => entry.name === ".git"));
        let nextTree = entriesToNodes(normalizedRoot, rootEntries);

        const relative = normalizedTarget === normalizedRoot
          ? ""
          : normalizedTarget.slice(normalizedRoot.length + 1);
        const parts = relative ? relative.split("/").filter(Boolean) : [];
        const ancestorsToExpand =
          targetKind === "directory" ? parts : parts.slice(0, Math.max(parts.length - 1, 0));

        let currentPath = normalizedRoot;
        for (const segment of ancestorsToExpand) {
          currentPath = `${currentPath}/${segment}`;
          const node = findNodeByPath(nextTree, currentPath);
          if (!node || !node.isDirectory) break;

          const entries = await listFilesSafe(fileOpsContainerId, currentPath);
          const hasGit = entries.some((entry) => entry.name === ".git");
          const children = entriesToNodes(currentPath, entries);
          nextTree = updateNodeByPath(nextTree, currentPath, (existing) => ({
            ...existing,
            isGitRepo: hasGit,
            children,
            expanded: true,
            loading: false,
          }));
        }

        setTree(nextTree);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            rowRefs.current.get(normalizedTarget)?.scrollIntoView({ block: "nearest" });
          });
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to reveal path");
      } finally {
        setLoading(false);
      }
    },
    [fileOpsContainerId, entriesToNodes, rootPath],
  );

  useEffect(() => {
    if (!open || !revealRequest) return;
    if (!pathWithinRoot(rootPath, revealRequest.path)) return;
    void revealPath(revealRequest.path, revealRequest.kind);
  }, [open, revealPath, revealRequest, rootPath]);

  const handleDeleteEntry = async (node: TreeNode) => {
    if (!fileOpsContainerId) return;
    setActionBusy(true);
    setError(null);
    try {
      try {
        await dockerClient.deleteFile(fileOpsContainerId, node.path);
      } catch (e) {
        if (!isContainerNotRunningError(e)) throw e;
        await ensureContainerRunning(fileOpsContainerId);
        await dockerClient.deleteFile(fileOpsContainerId, node.path);
      }
      await refreshDirectoryListing(parentDir(node.path));
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setActionBusy(false);
      setContextMenu(null);
    }
  };

  const handleCreateFile = async (parentPath: string) => {
    if (!fileOpsContainerId) return;
    const name = await askPrompt({ title: "New file", placeholder: "File name" });
    const trimmed = name?.trim();
    if (!trimmed) return;
    setActionBusy(true);
    try {
      try {
        await dockerClient.writeFile(fileOpsContainerId, `${parentPath}/${trimmed}`, "");
      } catch (e) {
        if (!isContainerNotRunningError(e)) throw e;
        await ensureContainerRunning(fileOpsContainerId);
        await dockerClient.writeFile(fileOpsContainerId, `${parentPath}/${trimmed}`, "");
      }
      await refreshDirectoryListing(parentPath);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create file");
    } finally {
      setActionBusy(false);
      setContextMenu(null);
    }
  };

  const handleCreateFolder = async (parentPath: string) => {
    if (!fileOpsContainerId) return;
    const name = await askPrompt({ title: "New folder", placeholder: "Folder name" });
    const trimmed = name?.trim();
    if (!trimmed) return;
    setActionBusy(true);
    try {
      try {
        await dockerClient.createDirectory(fileOpsContainerId, `${parentPath}/${trimmed}`);
      } catch (e) {
        if (!isContainerNotRunningError(e)) throw e;
        await ensureContainerRunning(fileOpsContainerId);
        await dockerClient.createDirectory(fileOpsContainerId, `${parentPath}/${trimmed}`);
      }
      await refreshDirectoryListing(parentPath);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create folder");
    } finally {
      setActionBusy(false);
      setContextMenu(null);
    }
  };

  const handleClearTmp = async () => {
    if (!fileOpsContainerId) return;
    setActionBusy(true);
    setError(null);
    try {
      try {
        await dockerClient.containerExec(fileOpsContainerId, [
          "sh",
          "-c",
          "rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* 2>/dev/null || true",
        ]);
      } catch (e) {
        if (!isContainerNotRunningError(e)) throw e;
        await ensureContainerRunning(fileOpsContainerId);
        await dockerClient.containerExec(fileOpsContainerId, [
          "sh",
          "-c",
          "rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* 2>/dev/null || true",
        ]);
      }
      await loadTree();
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear /tmp");
    } finally {
      setActionBusy(false);
      setContextMenu(null);
    }
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const indent = depth * 16;
    return (
      <div key={node.path}>
        <div
          ref={(el) => {
            if (el) rowRefs.current.set(node.path, el);
            else rowRefs.current.delete(node.path);
          }}
          className={[
            "flex items-center gap-1 px-1 py-0.5 text-xs cursor-pointer hover:bg-muted/60 rounded-sm",
          ].join(" ")}
          style={{ paddingLeft: `${indent + 4}px` }}
          onClick={() => {
            if (node.isDirectory) {
              void toggleExpand(node.path, !!node.expanded);
            } else {
              onOpenFileTemporary(node.path);
            }
          }}
          onDoubleClick={() => {
            if (!node.isDirectory) {
              onOpenFileEdit(node.path);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const clamped = clampContextMenuPosition(
              e.clientX,
              e.clientY,
              CONTEXT_MENU_ESTIMATED_WIDTH,
              CONTEXT_MENU_ESTIMATED_HEIGHT,
            );
            setContextMenu({
              x: clamped.x,
              y: clamped.y,
              anchorX: e.clientX,
              anchorY: e.clientY,
              node,
            });
          }}
        >
          {node.isDirectory ? (
            <>
              {node.loading ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : node.expanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              )}
              {node.expanded ? (
                <FolderOpen className="h-3.5 w-3.5" style={iconStyle("--file-browser-folder")} />
              ) : (
                <Folder className="h-3.5 w-3.5" style={iconStyle("--file-browser-folder")} />
              )}
              {node.expanded && node.isGitRepo && (
                <span className="inline-flex" title="Git repository" aria-label="Git repository">
                  <GitBranch className="h-3 w-3" style={iconStyle("--file-browser-git")} aria-hidden="true" />
                </span>

              )}
            </>
          ) : (
            <>
              <span className="w-3" />
              {fileIcon(node.name)}
            </>
          )}
          <span className="truncate text-foreground">{node.name}</span>
        </div>
        {node.isDirectory && node.expanded && node.children && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.children.length === 0 && !node.loading && (
              <div
                className="text-[10px] text-muted-foreground italic"
                style={{ paddingLeft: `${indent + 20}px` }}
              >
                (empty)
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const inWorkspace = id === "workspace";
  const projectMode = inWorkspace && !!workspaceProjectRoot;
  const effectiveTitle = inWorkspace && (projectMode || rootIsGitRepo) ? "Project" : title;

  return (
    <div
      className={[
        "border-b flex flex-col min-h-0",
      ].join(" ")}
      style={{
        flex: open ? `${flexGrow ?? 1} 1 0%` : "0 0 auto",
      }}
    >
      <div className="shrink-0 flex items-center">
        <button
          type="button"
          className="flex-1 flex items-center gap-1.5 px-2 py-2 text-xs font-medium text-foreground hover:bg-muted/40"
          onClick={onToggle}
        >
          <ChevronRight
            className={[
              "h-3 w-3 shrink-0 transition-transform",
              open ? "rotate-90" : "",
            ].join(" ")}
          />
          <span>{effectiveTitle}</span>
          {open && rootIsGitRepo && (
            <span className="inline-flex" title="Git repository" aria-label="Git repository">
              <GitBranch className="h-3 w-3" style={iconStyle("--file-browser-git")} aria-hidden="true" />
            </span>
          )}
          <span className="ml-1 text-[10px] text-muted-foreground font-mono truncate">
            {rootPath}
          </span>
        </button>
        <div className="shrink-0 flex items-center gap-0.5 pr-1">
          {open && inWorkspace && projectMode && (
            <IconButton
              label="Clear selected project"
              onClick={() => {
                setContextMenu(null);
                onClearWorkspaceProjectRoot?.();
              }}
            >
              <X className="h-3 w-3" />
            </IconButton>
          )}
          {open && id === "tmp" && (
            <IconButton
              label="Clear /tmp"
              disabled={actionBusy}
              onClick={() => {
                setContextMenu(null);
                setClearTmpConfirmOpen(true);
              }}
            >
              <Trash2 className="h-3 w-3" />
            </IconButton>
          )}
          {open && (
            <IconButton label={`Refresh ${effectiveTitle}`} onClick={() => void loadTree()}>
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </IconButton>
          )}
        </div>
      </div>

      {open && (
        <div className="flex-1 min-h-0 flex flex-col">
          {error && (
            <div className="mx-2 mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-auto p-1">
            {loading && tree.length === 0 ? (
              <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading files...
              </div>
            ) : tree.length === 0 ? (
              <div className="p-2 text-xs text-muted-foreground italic">
                {emptyMessage}
              </div>
            ) : (
              tree.map((node) => renderNode(node, 0))
            )}
          </div>

          {contextMenu &&
            typeof document !== "undefined" &&
            createPortal(
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-[9998] cursor-default bg-muted/50"
                  onClick={() => setContextMenu(null)}
                />
                <div
                  ref={contextMenuRef}
                  className="fixed z-[9999] min-w-40 rounded-md border bg-background p-1 shadow-lg opacity-95"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                  {contextMenu.node.isDirectory && (
                    <>
                      {inWorkspace &&
                        contextMenu.node.isGitRepo &&
                        typeof onSelectWorkspaceProjectRoot === "function" &&
                        typeof workspaceRootPath === "string" &&
                        pathWithinRoot(workspaceRootPath, contextMenu.node.path) && (
                          <button
                            type="button"
                            className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
                            disabled={actionBusy}
                            onClick={() => {
                              const nextRoot = normalizeAbsolutePath(contextMenu.node.path);
                              setContextMenu(null);
                              onSelectWorkspaceProjectRoot(nextRoot);
                            }}
                          >
                            Select Project
                          </button>
                        )}
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
                        disabled={actionBusy}
                        onClick={() => void handleCreateFile(contextMenu.node.path)}
                      >
                        New file
                      </button>
                      <button
                        type="button"
                        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
                        disabled={actionBusy}
                        onClick={() => void handleCreateFolder(contextMenu.node.path)}
                      >
                        New folder
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left text-xs text-destructive hover:bg-muted disabled:opacity-50"
                    disabled={actionBusy}
                    onClick={() => void handleDeleteEntry(contextMenu.node)}
                  >
                    Delete
                  </button>
                </div>
              </>,
              document.body,
            )}
        </div>
      )}

      {open && showResizeHandle && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize sections"
          className="shrink-0 h-2 cursor-row-resize bg-transparent hover:bg-muted/60 active:bg-muted/80"
          onPointerDown={onResizeHandlePointerDown}
        >
          <div className="h-full w-full flex items-center justify-center">
            <div className="h-0.5 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        </div>
      )}

      {id === "tmp" && clearTmpConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center lightbox-container p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Clear /tmp"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setClearTmpConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-xl border bg-background text-foreground shadow-lg">
            <div className="border-b px-4 py-3">
              <div className="text-sm font-semibold">Clear /tmp?</div>
              <div className="mt-1 text-xs text-muted-foreground">
                This will permanently remove all files and folders in <span className="font-mono">/tmp</span>.
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-destructive">
                This cannot be undone.
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
              <button
                type="button"
                className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                disabled={actionBusy}
                onClick={() => setClearTmpConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                disabled={actionBusy}
                onClick={() => {
                  setClearTmpConfirmOpen(false);
                  void handleClearTmp();
                }}
              >
                {actionBusy ? "Clearing..." : "Clear /tmp"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilesView (formerly VolumeView — now only the file tree browser)
// ---------------------------------------------------------------------------

export function VolumeView({
  fileOpsContainerId,
  onOpenFileTemporary,
  onOpenFileEdit,
  refreshNonce,
  onRefresh,
  revealRequest,
}: Props) {
  const [homeRootPath, setHomeRootPath] = useState("/home");
  const sectionsRef = useRef<HTMLDivElement | null>(null);
  const workspaceRootPath = "/git";
  const legacyWorkspaceRootPath = "/workspace";
  const [workspaceProjectRoot, setWorkspaceProjectRoot] = useState<string | null>(() => {
    try {
      const raw = getItem(FILES_WORKSPACE_PROJECT_ROOT_KEY);
      if (!raw) return null;
      const normalized = normalizeAbsolutePath(raw);
      const migrated =
        pathWithinRoot(legacyWorkspaceRootPath, normalized)
          ? `${workspaceRootPath}${normalized.slice(legacyWorkspaceRootPath.length)}`
          : normalized;
      if (!pathWithinRoot(workspaceRootPath, migrated)) return null;
      if (migrated === workspaceRootPath) return null;
      return migrated;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!fileOpsContainerId) return;
      try {
        const inspect = await dockerClient.inspectContainer(fileOpsContainerId);
        const next = getHomeRootFromInspect(inspect);
        if (!cancelled) setHomeRootPath(next);
      } catch {
        // Keep default.
        if (!cancelled) setHomeRootPath("/home");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [fileOpsContainerId]);

  const roots: FileRootConfig[] = FILE_ROOTS.map((r) => {
    if (r.id !== "home") return r;
    return {
      ...r,
      rootPath: homeRootPath,
      emptyMessage: `No files in ${homeRootPath}.`,
    };
  }).map((r) => {
    if (r.id !== "workspace") return r;
    const nextRoot = workspaceProjectRoot ?? workspaceRootPath;
    return {
      ...r,
      title: workspaceProjectRoot ? "Project" : r.title,
      rootPath: nextRoot,
      emptyMessage: `No files in ${nextRoot}. Create files or attach a volume.`,
    };
  });

  useEffect(() => {
    try {
      if (!workspaceProjectRoot) {
        removeItem(FILES_WORKSPACE_PROJECT_ROOT_KEY);
      } else {
        setItem(FILES_WORKSPACE_PROJECT_ROOT_KEY, workspaceProjectRoot);
      }
    } catch {
      // ignore
    }
  }, [workspaceProjectRoot]);

  const [openSections, setOpenSections] = useState<Set<FileRootConfig["id"]>>(() => {
    try {
      const parsed = readJSON<unknown>(FILES_OPEN_SECTIONS_KEY);
      if (parsed) {
        if (Array.isArray(parsed)) {
          const ids = parsed
            .map((v) => String(v))
            .filter((v): v is FileRootConfig["id"] => v === "root" || v === "workspace" || v === "home" || v === "tmp");
          if (ids.length > 0) return new Set(ids);
        }
    } catch {
      // ignore
    }
    // Default: only Workspace open
    return new Set<FileRootConfig["id"]>(["workspace"]);
  });

  const [sectionWeights, setSectionWeights] = useState<Record<FileRootConfig["id"], number>>(() => {
    try {
      const parsed = readJSON<unknown>(FILES_SECTION_WEIGHTS_KEY);
      if (parsed && typeof parsed === "object") {
        const getNum = (k: FileRootConfig["id"]) => {
          const v = (parsed as Record<string, unknown>)[k];
          return typeof v === "number" && Number.isFinite(v) ? Math.max(0.1, v) : 1;
        };
        return {
          root: getNum("root"),
          workspace: getNum("workspace"),
          home: getNum("home"),
          tmp: getNum("tmp"),
        };
      }
    } catch {
      // ignore
    }
    return { root: 1, workspace: 1, home: 1, tmp: 1 };
  });

  useEffect(() => {
    try {
      writeJSON(FILES_OPEN_SECTIONS_KEY, [...openSections]);
    } catch {
      // ignore
    }
  }, [openSections]);

  useEffect(() => {
    try {
      writeJSON(FILES_SECTION_WEIGHTS_KEY, sectionWeights);
    } catch {
      // ignore
    }
  }, [sectionWeights]);

  const toggleSection = useCallback((id: FileRootConfig["id"]) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        // Keep at least one section open so the Files tab doesn't go blank.
        if (next.size <= 1) return prev;
        next.delete(id);
        return next;
      }
      next.add(id);
      return next;
    });
  }, []);

  const beginResize = useCallback((id: FileRootConfig["id"], e: ReactPointerEvent<HTMLDivElement>) => {
    // Find the next open section after `id` so we resize the boundary between them.
    const i = roots.findIndex((r) => r.id === id);
    if (i < 0) return;
    const next = roots.slice(i + 1).find((r) => openSections.has(r.id));
    if (!next) return;

    const host = sectionsRef.current;
    if (!host) return;

    e.preventDefault();
    e.stopPropagation();

    const containerHeight = host.getBoundingClientRect().height || 1;
    const startY = e.clientY;

    const a = id;
    const b = next.id;

    const startA = sectionWeights[a] ?? 1;
    const startB = sectionWeights[b] ?? 1;
    const total = startA + startB;

    const minPx = 140;
    const minW = Math.min(total * 0.45, (minPx / containerHeight) * total);
    const clampA = (v: number) => Math.max(minW, Math.min(total - minW, v));

    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientY - startY;
      const deltaW = (delta / containerHeight) * total;
      const nextA = clampA(startA + deltaW);
      const nextB = total - nextA;
      setSectionWeights((prev) => ({ ...prev, [a]: nextA, [b]: nextB }));
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [openSections, roots, sectionWeights]);

  useEffect(() => {
    if (!revealRequest) return;
    const matchingRoot = roots.find((root) => pathWithinRoot(root.rootPath, revealRequest.path));
    if (!matchingRoot) return;
    setOpenSections((prev) => {
      if (prev.has(matchingRoot.id)) return prev;
      const next = new Set(prev);
      next.add(matchingRoot.id);
      return next;
    });
  }, [revealRequest, roots]);

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  if (!fileOpsContainerId) {
    return (
      <div className="p-3 space-y-3">
        <div className="text-xs font-medium text-foreground">Files</div>
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          File operations container isn’t available. Start Docker to browse files.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 p-2 border-b">
        <div className="text-xs font-medium text-foreground">Files</div>
      </div>

      <div ref={sectionsRef} className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {roots.map((root, idx) => {
          const open = openSections.has(root.id);
          const hasNextOpen = open && roots.slice(idx + 1).some((r) => openSections.has(r.id));
          return (
          <FileRootSection
            key={root.id}
            id={root.id}
            title={root.title}
            rootPath={root.rootPath}
            emptyMessage={root.emptyMessage}
            open={open}
            flexGrow={open ? (sectionWeights[root.id] ?? 1) : undefined}
            showResizeHandle={hasNextOpen}
            onResizeHandlePointerDown={(e) => beginResize(root.id, e)}
            refreshNonce={refreshNonce}
            fileOpsContainerId={fileOpsContainerId}
            onToggle={() => toggleSection(root.id)}
            onRefresh={onRefresh}
            onOpenFileTemporary={onOpenFileTemporary}
            onOpenFileEdit={onOpenFileEdit}
            revealRequest={revealRequest}
            workspaceRootPath={root.id === "workspace" ? workspaceRootPath : undefined}
            workspaceProjectRoot={root.id === "workspace" ? workspaceProjectRoot : undefined}
            onSelectWorkspaceProjectRoot={
              root.id === "workspace"
                ? (p) => {
                    const normalized = normalizeAbsolutePath(p);
                    if (!pathWithinRoot(workspaceRootPath, normalized)) return;
                    if (normalized === workspaceRootPath) {
                      setWorkspaceProjectRoot(null);
                    } else {
                      setWorkspaceProjectRoot(normalized);
                    }
                  }
                : undefined
            }
            onClearWorkspaceProjectRoot={root.id === "workspace" ? () => setWorkspaceProjectRoot(null) : undefined}
          />
          );
        })}
      </div>

    </div>
  );
}
