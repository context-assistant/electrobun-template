import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
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
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useInAppDialogs } from "../context/InAppDialogsContext";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import type { DockerUploadEntry, FileEntry } from "../electrobun/rpcSchema";

type Props = {
  containerId: string | null;
  containerName: string | null;
  dockerHost?: string | null;
  onOpenFileTemporary: (filePath: string) => boolean;
  onOpenFileEdit: (filePath: string) => boolean;
  refreshNonce: number;
  onRefresh: () => void;
  onWorkingDirectoryChange?: (containerId: string, cwd: string | null) => void;
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
  children?: TreeNode[];
  expanded?: boolean;
  loading?: boolean;
};

type PersistedTreeState = {
  cwd: string;
  expandedPaths: string[];
};

type DroppedResource = {
  kind: "file" | "directory";
  relativePath: string;
  file?: File;
};

type DragHandle = {
  kind: "file" | "directory";
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterable<DragHandle>;
};

type DragEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (callback: (file: File) => void, error?: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      callback: (entries: DragEntry[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
};

const DEFAULT_WORKING_DIRECTORY = "/workspace";
const TREE_STATE_CACHE_FILE = "/tmp/context-assistant-container-files-tree.v1.json";

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

function parentDir(path: string): string {
  const normalized = normalizeAbsolutePath(path);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

const CODE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "cc", "cs", "php", "sh", "bash", "zsh",
  "html", "htm", "css", "scss",
  "atom", "rdf", "rss", "xht", "xhtml", "xml", "jsonl", "jsonld", "jsonc", "geojson", "webmanifest"
]);

const CONFIG_EXTENSIONS = new Set(["yaml", "yml", "toml", "xml", "ini", "env"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const VIDEO_EXTENSIONS = new Set(["avi", "mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "aac", "opus", "flac"]);
const MODEL_3D_EXTENSIONS = new Set(["glb", "gltf", "usdz", "obj", "stl", "ply", "fbx"]);

function getFileExtension(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
}

const fileBrowserIconStyle = (varName: string) => ({ color: `var(${varName})` });

function getFileIcon(name: string) {
  const ext = getFileExtension(name);
  if (ext === "json" || ext === "jsonc") return <FileJson2 className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-json")} />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode2 className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-code")} />;
  if (CONFIG_EXTENSIONS.has(ext)) return <FileCog className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-config")} />;
  if (ext === "md" || ext === "markdown") return <FileText className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-markdown")} />;
  if (IMAGE_EXTENSIONS.has(ext)) {
    return <FileImage className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-image")} />;
  }
  if (VIDEO_EXTENSIONS.has(ext)) return <FileVideo2 className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-video")} />;
  if (AUDIO_EXTENSIONS.has(ext)) return <FileMusic className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-audio")} />;
  if (MODEL_3D_EXTENSIONS.has(ext)) return <Box className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-model3d")} />;
  return <File className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-default")} />;
}

function mergeTreeState(prev: TreeNode[], next: TreeNode[]): TreeNode[] {
  const prevByPath = new Map(prev.map((n) => [n.path, n] as const));
  return next.map((n) => {
    const existing = prevByPath.get(n.path);
    if (!existing || !n.isDirectory) return n;
    return {
      ...n,
      expanded: existing.expanded ?? n.expanded,
      loading: existing.loading ?? n.loading,
      children: mergeTreeState(existing.children ?? [], n.children ?? []),
    };
  });
}

function updateNodeByPath(nodes: TreeNode[], path: string, updater: (node: TreeNode) => TreeNode): TreeNode[] {
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

function isContainerNotRunningError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const lower = msg.toLowerCase();
  return (
    lower.includes("is not running") ||
    lower.includes("unable to upgrade to tcp, received 409") ||
    lower.includes("container is restarting")
  );
}

async function ensureContainerRunning(
  containerId: string,
  runDockerTask: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<void> {
  try {
    const inspect = await runDockerTask(async () => await dockerClient.inspectContainer(containerId));
    if (inspect.state.running) return;
  } catch {
    // ignore and try start
  }
  try {
    await runDockerTask(async () => await dockerClient.startContainer(containerId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    if (!msg.toLowerCase().includes("already running")) throw e;
  }
}

async function listFilesSafe(
  containerId: string,
  path: string,
  runDockerTask: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<FileEntry[]> {
  try {
    return await runDockerTask(async () => await dockerClient.listFiles(containerId, path));
  } catch (e) {
    if (!isContainerNotRunningError(e)) throw e;
    await ensureContainerRunning(containerId, runDockerTask);
    return await runDockerTask(async () => await dockerClient.listFiles(containerId, path));
  }
}

function toPersistedState(raw: unknown): { cwd: string; expandedPaths: Set<string> } {
  if (!raw || typeof raw !== "object") {
    return { cwd: DEFAULT_WORKING_DIRECTORY, expandedPaths: new Set<string>() };
  }
  const candidate = raw as PersistedTreeState;
  const cwd = normalizeAbsolutePath(typeof candidate.cwd === "string" ? candidate.cwd : DEFAULT_WORKING_DIRECTORY);
  const paths = candidate.expandedPaths;
  if (!Array.isArray(paths)) return { cwd, expandedPaths: new Set<string>() };
  const normalized = paths
    .map((value) => normalizeAbsolutePath(String(value ?? "")))
    .filter((path) => path !== "/" && pathWithinRoot(cwd, path));
  return { cwd, expandedPaths: new Set(normalized) };
}

function collectExpandedPaths(nodes: TreeNode[]): string[] {
  const result: string[] = [];
  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      if (!node.isDirectory || !node.expanded) continue;
      result.push(node.path);
      if (node.children && node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  result.sort((a, b) => a.localeCompare(b));
  return result;
}

async function isTmpWritable(
  containerId: string,
  runDockerTask: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<boolean> {
  const test = await runDockerTask(async () =>
    await dockerClient.containerExec(containerId, ["sh", "-lc", "test -w /tmp"]),
  );
  return test.exitCode === 0;
}

function isExternalFileDrag(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes("Files");
}

function joinRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function normalizeUploadRelativePath(path: string): string {
  const segments = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error("Dropped item path cannot be empty");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Invalid dropped path: ${path}`);
    }
  }
  return segments.join("/");
}

async function readEntryFile(entry: DragEntry): Promise<File> {
  return await new Promise<File>((resolve, reject) => {
    if (!entry.file) {
      reject(new Error(`Missing file reader for ${entry.name}`));
      return;
    }
    entry.file(resolve, (error) => reject(error));
  });
}

async function readDirectoryEntries(entry: DragEntry): Promise<DragEntry[]> {
  return await new Promise<DragEntry[]>((resolve, reject) => {
    const reader = entry.createReader?.();
    if (!reader) {
      reject(new Error(`Missing directory reader for ${entry.name}`));
      return;
    }
    const collected: DragEntry[] = [];
    const pump = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(collected);
            return;
          }
          collected.push(...entries);
          pump();
        },
        (error) => reject(error),
      );
    };
    pump();
  });
}

async function collectDroppedFromEntry(
  entry: DragEntry,
  relativePath: string,
): Promise<DroppedResource[]> {
  const normalizedPath = normalizeUploadRelativePath(relativePath);
  if (entry.isFile) {
    return [
      {
        kind: "file",
        relativePath: normalizedPath,
        file: await readEntryFile(entry),
      },
    ];
  }
  if (!entry.isDirectory) return [];

  const resources: DroppedResource[] = [
    {
      kind: "directory",
      relativePath: normalizedPath,
    },
  ];
  const children = await readDirectoryEntries(entry);
  for (const child of children) {
    resources.push(
      ...(await collectDroppedFromEntry(child, joinRelativePath(normalizedPath, child.name))),
    );
  }
  return resources;
}

async function collectDroppedFromHandle(
  handle: DragHandle,
  relativePath: string,
): Promise<DroppedResource[]> {
  const normalizedPath = normalizeUploadRelativePath(relativePath);
  if (handle.kind === "file") {
    if (!handle.getFile) {
      throw new Error(`Missing file handle for ${handle.name}`);
    }
    return [
      {
        kind: "file",
        relativePath: normalizedPath,
        file: await handle.getFile(),
      },
    ];
  }

  const resources: DroppedResource[] = [
    {
      kind: "directory",
      relativePath: normalizedPath,
    },
  ];
  if (!handle.values) return resources;
  for await (const child of handle.values()) {
    resources.push(
      ...(await collectDroppedFromHandle(child, joinRelativePath(normalizedPath, child.name))),
    );
  }
  return resources;
}

async function collectDroppedResources(dataTransfer: DataTransfer): Promise<DroppedResource[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const collected: DroppedResource[] = [];

  for (const item of items) {
    if (item.kind !== "file") continue;

    const handleGetter = (
      item as DataTransferItem & {
        getAsFileSystemHandle?: () => Promise<DragHandle>;
      }
    ).getAsFileSystemHandle;
    if (typeof handleGetter === "function") {
      try {
        const handle = await handleGetter.call(item);
        if (handle) {
          collected.push(...(await collectDroppedFromHandle(handle, handle.name)));
          continue;
        }
      } catch {
        // Fall through to Chromium's older entry API or basic File objects.
      }
    }

    const entryGetter = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => DragEntry | null;
      }
    ).webkitGetAsEntry;
    if (typeof entryGetter === "function") {
      const entry = entryGetter.call(item);
      if (entry) {
        collected.push(...(await collectDroppedFromEntry(entry, entry.name)));
        continue;
      }
    }

    const file = item.getAsFile();
    if (file) {
      collected.push({
        kind: "file",
        relativePath: normalizeUploadRelativePath(file.webkitRelativePath || file.name),
        file,
      });
    }
  }

  if (collected.length > 0) return collected;

  return Array.from(dataTransfer.files ?? []).map((file) => ({
    kind: "file" as const,
    relativePath: normalizeUploadRelativePath(file.webkitRelativePath || file.name),
    file,
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function serializeDroppedResources(
  resources: DroppedResource[],
): Promise<DockerUploadEntry[]> {
  const directoryPaths = new Set<string>();
  const fileEntries = new Map<string, DockerUploadEntry>();

  for (const resource of resources) {
    const relativePath = normalizeUploadRelativePath(resource.relativePath);
    if (resource.kind === "directory") {
      directoryPaths.add(relativePath);
      continue;
    }
    if (!resource.file) {
      throw new Error(`Missing file data for ${relativePath}`);
    }
    const arrayBuffer = await resource.file.arrayBuffer();
    fileEntries.set(relativePath, {
      kind: "file",
      relativePath,
      contentBase64: bytesToBase64(new Uint8Array(arrayBuffer)),
    });
  }

  return [
    ...Array.from(directoryPaths)
      .sort((a, b) => a.localeCompare(b))
      .map((relativePath) => ({
        kind: "directory" as const,
        relativePath,
      })),
    ...Array.from(fileEntries.values()).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
  ];
}

function formatUploadSummary(fileCount: number, directoryCount: number): string {
  const parts: string[] = [];
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  if (directoryCount > 0) {
    parts.push(`${directoryCount} folder${directoryCount === 1 ? "" : "s"}`);
  }
  return parts.join(" and ");
}

export function ContainerFilesTab({
  containerId,
  containerName,
  dockerHost = null,
  onOpenFileTemporary,
  onOpenFileEdit,
  refreshNonce,
  onRefresh,
  onWorkingDirectoryChange,
  revealRequest,
}: Props) {
  const CONTEXT_MENU_MARGIN = 8;
  const CONTEXT_MENU_ESTIMATED_WIDTH = 200;
  const CONTEXT_MENU_ESTIMATED_HEIGHT = 240;
  const { askPrompt } = useInAppDialogs();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    anchorX: number;
    anchorY: number;
    node: TreeNode;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<TreeNode | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [footerMessage, setFooterMessage] = useState<string | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState(DEFAULT_WORKING_DIRECTORY);
  const [tmpPersistenceReady, setTmpPersistenceReady] = useState(false);
  const [tmpPersistenceEnabled, setTmpPersistenceEnabled] = useState(false);
  const persistedExpandedPathsRef = useRef<Set<string>>(new Set());
  const persistTimerRef = useRef<number | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const runDockerTask = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T> =>
      await dockerClient.runWithDockerHost(dockerHost, task),
    [dockerHost],
  );

  const loadRequestIdRef = useRef(0);
  const footerMessageTimerRef = useRef<number | null>(null);

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

  const showFooterMessage = useCallback((message: string) => {
    if (footerMessageTimerRef.current != null) {
      window.clearTimeout(footerMessageTimerRef.current);
      footerMessageTimerRef.current = null;
    }
    setFooterMessage(message);
    footerMessageTimerRef.current = window.setTimeout(() => {
      setFooterMessage(null);
      footerMessageTimerRef.current = null;
    }, 4000);
  }, []);

  const entriesToNodes = useCallback((basePath: string, entries: FileEntry[]): TreeNode[] => {
    const nodes: TreeNode[] = entries
      .filter((entry) => entry.name !== ".git")
      .map((entry) => ({
        name: entry.name,
        path: `${basePath === "/" ? "" : basePath}/${entry.name}`,
        isDirectory: entry.isDirectory,
        expanded: false,
        loading: false,
        children: entry.isDirectory ? [] : undefined,
      }));
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }, []);

  const withContainerRetry = useCallback(
    async <T,>(runner: () => Promise<T>): Promise<T> => {
      try {
        return await runner();
      } catch (e) {
        if (!isContainerNotRunningError(e) || !containerId) throw e;
        await ensureContainerRunning(containerId, runDockerTask);
        return await runner();
      }
    },
    [containerId],
  );

  const restoreExpandedState = useCallback(
    async (initialTree: TreeNode[]): Promise<TreeNode[]> => {
      if (!containerId || !tmpPersistenceEnabled || persistedExpandedPathsRef.current.size === 0) {
        return initialTree;
      }

      let nextTree = initialTree;
      const targets = [...persistedExpandedPathsRef.current].sort(
        (a, b) => a.split("/").length - b.split("/").length,
      );
      const loadedDirectories = new Set<string>();

      for (const targetPath of targets) {
        const normalizedTarget = normalizeAbsolutePath(targetPath);
        if (!pathWithinRoot(workingDirectory, normalizedTarget)) continue;
        const relative = normalizedTarget === workingDirectory
          ? ""
          : normalizedTarget.slice(workingDirectory.length + (workingDirectory === "/" ? 0 : 1));
        const segments = relative.split("/").filter(Boolean);
        let currentPath = normalizeAbsolutePath(workingDirectory);
        for (const segment of segments) {
          currentPath = `${currentPath === "/" ? "" : currentPath}/${segment}`;
          const node = findNodeByPath(nextTree, currentPath);
          if (!node || !node.isDirectory) break;
          if (!loadedDirectories.has(currentPath)) {
            const entries = await withContainerRetry(async () =>
              await listFilesSafe(containerId, currentPath, runDockerTask),
            );
            const children = entriesToNodes(currentPath, entries);
            nextTree = updateNodeByPath(nextTree, currentPath, (n) => ({
              ...n,
              expanded: true,
              loading: false,
              children: mergeTreeState(n.children ?? [], children),
            }));
            loadedDirectories.add(currentPath);
            continue;
          }
          nextTree = updateNodeByPath(nextTree, currentPath, (n) => ({ ...n, expanded: true, loading: false }));
        }
      }
      return nextTree;
    },
    [containerId, entriesToNodes, tmpPersistenceEnabled, withContainerRetry, workingDirectory],
  );

  useEffect(() => {
    if (!containerId) {
      setTmpPersistenceReady(true);
      setTmpPersistenceEnabled(false);
      persistedExpandedPathsRef.current = new Set();
      setWorkingDirectory(DEFAULT_WORKING_DIRECTORY);
      return;
    }
    let cancelled = false;
    setTmpPersistenceReady(false);
    setTmpPersistenceEnabled(false);
    persistedExpandedPathsRef.current = new Set();
    setWorkingDirectory(DEFAULT_WORKING_DIRECTORY);

    const hydrate = async () => {
      try {
        const writable = await withContainerRetry(async () => await isTmpWritable(containerId, runDockerTask));
        if (cancelled) return;
        if (!writable) {
          setTmpPersistenceEnabled(false);
          setTmpPersistenceReady(true);
          return;
        }

        let nextCwd = DEFAULT_WORKING_DIRECTORY;
        let loaded = new Set<string>();
        try {
          const raw = await withContainerRetry(async () =>
            await runDockerTask(async () => await dockerClient.readFile(containerId, TREE_STATE_CACHE_FILE)),
          );
          const persisted = toPersistedState(JSON.parse(raw));
          nextCwd = persisted.cwd;
          loaded = persisted.expandedPaths;
        } catch {
          loaded = new Set<string>();
        }
        if (cancelled) return;
        setWorkingDirectory(nextCwd);
        persistedExpandedPathsRef.current = loaded;
        setTmpPersistenceEnabled(true);
      } catch {
        if (cancelled) return;
        setTmpPersistenceEnabled(false);
      } finally {
        if (!cancelled) setTmpPersistenceReady(true);
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [containerId, withContainerRetry]);

  const loadTree = useCallback(async () => {
    if (!containerId) {
      setTree([]);
      return;
    }
    if (!tmpPersistenceReady) return;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const entries = await withContainerRetry(async () =>
        await listFilesSafe(containerId, workingDirectory, runDockerTask),
      );
      let nextTree = entriesToNodes(workingDirectory, entries);
      nextTree = await restoreExpandedState(nextTree);
      if (loadRequestIdRef.current !== requestId) return;
      setTree((prev) => mergeTreeState(prev, nextTree));
    } catch (e) {
      if (loadRequestIdRef.current !== requestId) return;
      const message = e instanceof Error ? e.message : "Failed to list files";
      const missingDir = message.toLowerCase().includes("no such file or directory");
      if (missingDir && workingDirectory !== "/") {
        setWorkingDirectory("/");
        return;
      }
      setError(message);
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [containerId, entriesToNodes, restoreExpandedState, tmpPersistenceReady, withContainerRetry, workingDirectory]);

  useEffect(() => {
    void loadTree();
  }, [loadTree, refreshNonce]);

  useEffect(() => {
    if (!containerId || !tmpPersistenceReady || !tmpPersistenceEnabled) return;
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const expandedPaths = collectExpandedPaths(tree).filter((path) => pathWithinRoot(workingDirectory, path));
    persistTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = JSON.stringify({ cwd: workingDirectory, expandedPaths }, null, 2);
          await withContainerRetry(async () =>
            await runDockerTask(async () => await dockerClient.writeFile(containerId, TREE_STATE_CACHE_FILE, payload)),
          );
        } catch {
          // Disable persistence when /tmp writes fail.
          setTmpPersistenceEnabled(false);
        }
      })();
    }, 250);
    return () => {
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [containerId, tmpPersistenceEnabled, tmpPersistenceReady, tree, withContainerRetry, workingDirectory]);

  const refreshDirectoryListing = useCallback(
    async (dirPath: string) => {
      if (!containerId) return;
      if (dirPath === workingDirectory) {
        await loadTree();
        return;
      }

      setTree((prev) =>
        updateNodeByPath(prev, dirPath, (node) => ({
          ...node,
          loading: true,
        })),
      );

      try {
        const entries = await withContainerRetry(async () =>
          await listFilesSafe(containerId, dirPath, runDockerTask),
        );
        const nextChildren = entriesToNodes(dirPath, entries);
        setTree((prev) =>
          updateNodeByPath(prev, dirPath, (node) => ({
            ...node,
            loading: false,
            children: mergeTreeState(node.children ?? [], nextChildren),
          })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to refresh directory");
        setTree((prev) => updateNodeByPath(prev, dirPath, (node) => ({ ...node, loading: false })));
      }
    },
    [containerId, entriesToNodes, loadTree, withContainerRetry, workingDirectory],
  );

  const toggleExpand = useCallback(
    async (path: string, expanded: boolean) => {
      if (!containerId) return;
      const node = findNodeByPath(tree, path);
      if (!node || !node.isDirectory) return;

      if (expanded) {
        setTree((prev) => updateNodeByPath(prev, path, (n) => ({ ...n, expanded: false })));
        return;
      }

      setTree((prev) => updateNodeByPath(prev, path, (n) => ({ ...n, expanded: true, loading: true })));
      try {
        const entries = await withContainerRetry(async () =>
          await listFilesSafe(containerId, path, runDockerTask),
        );
        const children = entriesToNodes(path, entries);
        setTree((prev) =>
          updateNodeByPath(prev, path, (n) => ({
            ...n,
            loading: false,
            children: mergeTreeState(n.children ?? [], children),
          })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to expand folder");
        setTree((prev) => updateNodeByPath(prev, path, (n) => ({ ...n, loading: false })));
      }
    },
    [containerId, entriesToNodes, tree, withContainerRetry],
  );

  const revealPath = useCallback(
    async (targetPath: string, kind: "file" | "directory") => {
      if (!containerId) return;
      setLoading(true);
      setError(null);
      try {
        const normalizedRoot = normalizeAbsolutePath(workingDirectory);
        const normalizedTarget = normalizeAbsolutePath(targetPath);
        if (!pathWithinRoot(normalizedRoot, normalizedTarget)) return;

        const rootEntries = await withContainerRetry(async () =>
          await listFilesSafe(containerId, normalizedRoot, runDockerTask),
        );
        let nextTree = entriesToNodes(normalizedRoot, rootEntries);
        const parts = normalizedTarget.slice(normalizedRoot.length).split("/").filter(Boolean);
        let currentPath = normalizedRoot;

        for (const part of parts) {
          currentPath = `${currentPath === "/" ? "" : currentPath}/${part}`;
          const node = findNodeByPath(nextTree, currentPath);
          if (!node) break;
          if (node.isDirectory) {
            node.expanded = true;
            const entries = await withContainerRetry(async () =>
              await listFilesSafe(containerId, currentPath, runDockerTask),
            );
            const children = entriesToNodes(currentPath, entries);
            node.children = children;
          }
        }

        if (kind === "directory") {
          const dirNode = findNodeByPath(nextTree, normalizedTarget);
          if (dirNode?.isDirectory) dirNode.expanded = true;
        }

        setTree((prev) => mergeTreeState(prev, nextTree));
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
    [containerId, entriesToNodes, withContainerRetry, workingDirectory],
  );

  useEffect(() => {
    if (!revealRequest) return;
    if (!pathWithinRoot(workingDirectory, revealRequest.path)) return;
    void revealPath(revealRequest.path, revealRequest.kind);
  }, [revealPath, revealRequest, workingDirectory]);

  useEffect(() => {
    if (!containerId) return;
    onWorkingDirectoryChange?.(containerId, workingDirectory);
  }, [containerId, onWorkingDirectoryChange, workingDirectory]);

  useEffect(
    () => () => {
      if (footerMessageTimerRef.current != null) {
        window.clearTimeout(footerMessageTimerRef.current);
        footerMessageTimerRef.current = null;
      }
    },
    [],
  );

  const selectWorkingDirectory = useCallback((nextPath: string) => {
    const normalized = normalizeAbsolutePath(nextPath);
    setWorkingDirectory(normalized);
    setTree([]);
    setError(null);
    setContextMenu(null);
  }, []);

  const goUpDirectory = useCallback(() => {
    if (workingDirectory === "/") return;
    selectWorkingDirectory(parentDir(workingDirectory));
  }, [selectWorkingDirectory, workingDirectory]);

  const handleImportDrop = useCallback(
    async (targetDirectory: string, dataTransfer: DataTransfer) => {
      if (!containerId) return;
      if (actionBusy || uploadBusy) {
        showFooterMessage("Another file operation is already in progress.");
        return;
      }

      setActionBusy(true);
      setUploadBusy(true);
      setUploadTargetPath(targetDirectory);
      setDropTargetPath(null);
      setError(null);
      setContextMenu(null);

      try {
        const droppedResources = await collectDroppedResources(dataTransfer);
        if (droppedResources.length === 0) {
          showFooterMessage("No files or folders found in drop.");
          return;
        }

        const entries = await serializeDroppedResources(droppedResources);
        await withContainerRetry(async () =>
          await runDockerTask(async () =>
            await dockerClient.importFiles(containerId, targetDirectory, entries),
          ),
        );
        await refreshDirectoryListing(targetDirectory);
        onRefresh();

        const fileCount = entries.filter((entry) => entry.kind === "file").length;
        const directoryCount = entries.filter(
          (entry) => entry.kind === "directory",
        ).length;
        showFooterMessage(
          `Copied ${formatUploadSummary(fileCount, directoryCount)} into ${targetDirectory}`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to copy dropped files");
      } finally {
        setUploadTargetPath(null);
        setUploadBusy(false);
        setActionBusy(false);
      }
    },
    [
      actionBusy,
      containerId,
      onRefresh,
      refreshDirectoryListing,
      runDockerTask,
      showFooterMessage,
      uploadBusy,
      withContainerRetry,
    ],
  );

  const handlePaneDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropTargetPath(workingDirectory);
    },
    [workingDirectory],
  );

  const handlePaneDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalFileDrag(event)) return;
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }
      setDropTargetPath((prev) => (prev === workingDirectory ? null : prev));
    },
    [workingDirectory],
  );

  const handlePaneDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isExternalFileDrag(event)) return;
      event.preventDefault();
      void handleImportDrop(workingDirectory, event.dataTransfer);
    },
    [handleImportDrop, workingDirectory],
  );

  const handleDeleteEntry = async (node: TreeNode) => {
    if (!containerId) return;
    setActionBusy(true);
    setError(null);
    try {
      await withContainerRetry(async () =>
        await runDockerTask(async () => await dockerClient.deleteFile(containerId, node.path)),
      );
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
    if (!containerId) return;
    const name = await askPrompt({ title: "New file", placeholder: "File name" });
    const trimmed = name?.trim();
    if (!trimmed) return;
    setActionBusy(true);
    try {
      await withContainerRetry(async () =>
        await runDockerTask(async () => await dockerClient.writeFile(containerId, `${parentPath}/${trimmed}`, "")),
      );
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
    if (!containerId) return;
    const name = await askPrompt({ title: "New folder", placeholder: "Folder name" });
    const trimmed = name?.trim();
    if (!trimmed) return;
    setActionBusy(true);
    try {
      await withContainerRetry(async () =>
        await runDockerTask(async () => await dockerClient.createDirectory(containerId, `${parentPath}/${trimmed}`)),
      );
      await refreshDirectoryListing(parentPath);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create folder");
    } finally {
      setActionBusy(false);
      setContextMenu(null);
    }
  };

  const openRenameModal = useCallback((node: TreeNode) => {
    setRenameTarget(node);
    setRenameName(node.name);
    setRenameError(null);
    setContextMenu(null);
  }, []);

  const closeRenameModal = useCallback((force = false) => {
    if (actionBusy && !force) return;
    setRenameTarget(null);
    setRenameName("");
    setRenameError(null);
  }, [actionBusy]);

  useEffect(() => {
    if (!renameTarget || typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRenameModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeRenameModal, renameTarget]);

  const handleRenameEntry = async () => {
    if (!containerId || !renameTarget) return;
    const trimmedName = renameName.trim();
    if (!trimmedName) {
      setRenameError(`${renameTarget.isDirectory ? "Folder" : "File"} name cannot be empty`);
      return;
    }
    if (trimmedName.includes("/")) {
      setRenameError("Name cannot contain '/'");
      return;
    }

    const oldPath = renameTarget.path;
    const parentPath = parentDir(renameTarget.path);
    const newPath = `${parentPath === "/" ? "" : parentPath}/${trimmedName}`;
    if (oldPath === newPath) {
      closeRenameModal();
      return;
    }

    setActionBusy(true);
    setRenameError(null);
    try {
      await withContainerRetry(async () =>
        await runDockerTask(async () => await dockerClient.renameFile(containerId, oldPath, newPath)),
      );
      await refreshDirectoryListing(parentPath);
      onRefresh();
      closeRenameModal(true);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : "Failed to rename");
    } finally {
      setActionBusy(false);
    }
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const indent = depth * 16;
    const isDirectoryDropTarget = node.isDirectory && dropTargetPath === node.path;
    return (
      <div key={node.path}>
        <div
          ref={(el) => {
            if (el) rowRefs.current.set(node.path, el);
            else rowRefs.current.delete(node.path);
          }}
          className={`flex items-center gap-1 px-1 py-0.5 text-xs cursor-pointer rounded-sm ${
            isDirectoryDropTarget
              ? "bg-primary/15 ring-1 ring-inset ring-primary/40"
              : "hover:bg-muted/60"
          }`}
          style={{ paddingLeft: `${indent + 4}px` }}
          onClick={() => {
            if (node.isDirectory) void toggleExpand(node.path, !!node.expanded);
            else if (!onOpenFileTemporary(node.path)) showFooterMessage("Unsupported file type: " + node.path);
          }}
          onDoubleClick={() => {
            if (!node.isDirectory && !onOpenFileEdit(node.path)) {
              showFooterMessage("Unsupported file type: " + node.path);
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
          onDragOver={
            node.isDirectory
              ? (event) => {
                  if (!isExternalFileDrag(event)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "copy";
                  setDropTargetPath(node.path);
                }
              : undefined
          }
          onDragLeave={
            node.isDirectory
              ? (event) => {
                  if (!isExternalFileDrag(event)) return;
                  event.stopPropagation();
                  const nextTarget = event.relatedTarget;
                  if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
                    return;
                  }
                  setDropTargetPath((prev) => (prev === node.path ? null : prev));
                }
              : undefined
          }
          onDrop={
            node.isDirectory
              ? (event) => {
                  if (!isExternalFileDrag(event)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  void handleImportDrop(node.path, event.dataTransfer);
                }
              : undefined
          }
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
                <FolderOpen className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-folder")} />
              ) : (
                <Folder className="h-3.5 w-3.5" style={fileBrowserIconStyle("--file-browser-folder")} />
              )}
            </>
          ) : (
            <>
              <span className="w-3" />
              {getFileIcon(node.name)}
            </>
          )}
          <span className="truncate text-foreground">{node.name}</span>
        </div>
        {node.isDirectory && node.expanded && node.children && (
          <div>
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.children.length === 0 && !node.loading && (
              <div className="text-[10px] text-muted-foreground italic" style={{ paddingLeft: `${indent + 20}px` }}>
                (empty)
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const rootLabel = useMemo(() => {
    if (!containerName) return "Container Files";
    return `${containerName}`;
  }, [containerName]);

  const breadcrumbItems = useMemo(() => {
    if (workingDirectory === "/") {
      return [{ label: "/", path: "/" }];
    }
    const parts = workingDirectory.split("/").filter(Boolean);
    const items: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      items.push({ label: part, path: current });
    }
    return items;
  }, [workingDirectory]);

  if (!containerId) {
    return (
      <div className="p-3 space-y-3">
        <div className="text-xs font-medium text-foreground">Container Files</div>
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Select a running container to browse its filesystem.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 p-2 border-b space-y-2">
        <div className="flex items-center justify-between">
          <div className="min-w-0 overflow-x-auto">
            <div className="flex items-center whitespace-nowrap text-[10px] font-mono text-muted-foreground justify-end">
              {breadcrumbItems.map((crumb, index) => {
                const isCurrent = crumb.path === workingDirectory;
                return (
                  <div key={crumb.path} className="flex items-center">
                    {index > 0 && <span className="text-muted-foreground/70">/</span>}
                    <button
                      type="button"
                      className={`rounded-sm px-1 hover:bg-muted/60 ${
                        isCurrent ? "text-foreground cursor-default" : "text-muted-foreground"
                      }`}
                      onClick={() => {
                        if (!isCurrent) selectWorkingDirectory(crumb.path);
                      }}
                      disabled={isCurrent}
                    >
                      {crumb.label === "/" && index === 0 ? rootLabel : crumb.label}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Up directory" onClick={goUpDirectory} disabled={workingDirectory === "/"}>
              <ArrowUp className="h-3 w-3" />
            </IconButton>
            <IconButton label="Refresh files" onClick={() => void loadTree()}>
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </IconButton>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground">
          <span>Drop files or folders here to copy into the current directory.</span>
          {!tmpPersistenceEnabled && tmpPersistenceReady && (
            <span className="ml-2">(expand state persistence disabled)</span>
          )}
        </div>
      </div>

      {error && (
        <div className="shrink-0 mx-2 mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div
        className={`flex-1 min-h-0 overflow-auto p-1 transition-colors ${
          dropTargetPath === workingDirectory
            ? "bg-primary/10 ring-1 ring-inset ring-primary/35"
            : ""
        }`}
        onDragOver={handlePaneDragOver}
        onDragLeave={handlePaneDragLeave}
        onDrop={handlePaneDrop}
      >
        {loading && tree.length === 0 ? (
          <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading files...
          </div>
        ) : tree.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground italic">No files found in {workingDirectory}.</div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>
      {footerMessage &&
        <div className="shrink-0 min-h-6 border-t px-2 py-1 text-[11px] text-muted-foreground bg-orange-800 text-yellow-100 opacity-75">
          {footerMessage}
        </div>
      }
      {uploadBusy && (
        <div className="shrink-0 border-t px-2 py-1 text-[11px] text-muted-foreground">
          Copying dropped files into{" "}
          <span className="font-mono">{uploadTargetPath ?? workingDirectory}</span>
          ...
        </div>
      )}

      {contextMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <button type="button" className="fixed inset-0 z-[9998] cursor-default bg-muted/50" onClick={() => setContextMenu(null)} />
            <div
              ref={contextMenuRef}
              className="fixed z-[9999] min-w-40 rounded-md border bg-background p-1 shadow-lg opacity-95"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {contextMenu.node.isDirectory && (
                <>
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50 border-b"
                    disabled={actionBusy}
                    onClick={() => selectWorkingDirectory(contextMenu.node.path)}
                  >
                    Select as Working Directory
                  </button>
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
                    className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50 border-b"
                    disabled={actionBusy}
                    onClick={() => void handleCreateFolder(contextMenu.node.path)}
                  >
                    New folder
                  </button>
                </>
              )}
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50 border-b"
                disabled={actionBusy}
                onClick={() => openRenameModal(contextMenu.node)}
              >
                Rename
              </button>
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

      {renameTarget &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/35 p-4">
            <button type="button" className="absolute inset-0 cursor-default" onClick={() => closeRenameModal()} />
            <form
              className="relative z-[10001] w-full max-w-sm rounded-md border bg-background p-3 shadow-xl"
              onSubmit={(e) => {
                e.preventDefault();
                void handleRenameEntry();
              }}
            >
              <div className="mb-2 text-sm font-medium text-foreground">
                Rename {renameTarget.isDirectory ? "folder" : "file"}
              </div>
              <div className="mb-3 text-[11px] text-muted-foreground truncate" title={renameTarget.path}>
                {renameTarget.path}
              </div>
              <input
                type="text"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
                value={renameName}
                disabled={actionBusy}
                onChange={(e) => setRenameName(e.target.value)}
                autoFocus
                spellCheck={false}
              />
              {renameError && (
                <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                  {renameError}
                </div>
              )}
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  disabled={actionBusy}
                  onClick={() => closeRenameModal()}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md border border-primary bg-primary/15 px-2.5 py-1.5 text-xs text-primary disabled:opacity-50"
                  disabled={actionBusy}
                >
                  {actionBusy ? "Renaming..." : "Rename"}
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
    </div>
  );
}

// Backward-compatible export for any remaining legacy imports.
export const VolumesTab = ContainerFilesTab;
