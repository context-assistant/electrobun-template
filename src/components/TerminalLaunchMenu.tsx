import { useEffect, useMemo, useState } from "react";
import type { ContainerInfo } from "../electrobun/rpcSchema";
import type { RemoteSshEndpoint } from "../lib/appStorage";
import {
  MODEL_TYPE_LABELS,
  MODEL_TYPE_DISPLAY,
  type ProviderModel,
  type ProviderModelType,
} from "../lib/modelProviders";
import * as dockerClient from "../lib/docker";
import { getConfiguredContainerShells } from "../lib/containerShells";
import type { TerminalTabDescriptor } from "./ContainerTerminal";

type Props = {
  localTerminalEnabled?: boolean;
  dockerLocalEnabled?: boolean;
  dockerRemoteEnabled?: boolean;
  dockerModelEnabled?: boolean;
  ollamaLocalEnabled?: boolean;
  ollamaRemoteEnabled?: boolean;
  ollamaModelEnabled?: boolean;
  enabledLocalShells?: string[];
  remoteEndpoints?: RemoteSshEndpoint[];
  dockerLocalContainers?: ContainerInfo[];
  dockerRemoteContainers?: ContainerInfo[];
  dockerLocalModels?: ProviderModel[];
  dockerRemoteModels?: ProviderModel[];
  ollamaLocalModels?: ProviderModel[];
  ollamaRemoteModels?: ProviderModel[];
  remoteDockerHost?: string | null;
  remoteOllamaHost?: string | null;
  preferredShellCwdByContainerId?: Record<string, string>;
  onSelectDescriptor: (descriptor: TerminalTabDescriptor) => void;
};

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

function normalizeEnabledShells(value: string[] | undefined): Set<string> {
  return new Set(
    (value ?? [])
      .map((entry) => {
        const normalized = entry.trim().toLowerCase();
        return normalized.includes("/") ? (normalized.split("/").pop() ?? "") : normalized;
      })
      .filter((entry) => entry.length > 0),
  );
}

type ModelEntry = {
  source: "docker" | "ollama";
  environment: "local" | "remote";
  host: string | null;
  model: ProviderModel;
};

export function TerminalLaunchMenu({
  localTerminalEnabled = true,
  dockerLocalEnabled = false,
  dockerRemoteEnabled = false,
  dockerModelEnabled = false,
  ollamaLocalEnabled = false,
  ollamaRemoteEnabled = false,
  ollamaModelEnabled = false,
  enabledLocalShells = ["bash", "zsh"],
  remoteEndpoints = [],
  dockerLocalContainers = [],
  dockerRemoteContainers = [],
  dockerLocalModels = [],
  dockerRemoteModels = [],
  ollamaLocalModels = [],
  ollamaRemoteModels = [],
  remoteDockerHost = null,
  remoteOllamaHost = null,
  preferredShellCwdByContainerId,
  onSelectDescriptor,
}: Props) {
  const [localShells, setLocalShells] = useState<string[]>([]);
  const [localShellsLoading, setLocalShellsLoading] = useState(false);
  const [localShellsError, setLocalShellsError] = useState<string | null>(null);
  const [selectedModelTypes, setSelectedModelTypes] = useState<ProviderModelType[]>([]);

  useEffect(() => {
    if (!localTerminalEnabled) return;
    let cancelled = false;
    setLocalShellsLoading(true);
    setLocalShellsError(null);
    void dockerClient
      .listLocalShells()
      .then((nextShells) => {
        if (cancelled) return;
        setLocalShells(nextShells);
      })
      .catch((error) => {
        if (cancelled) return;
        setLocalShellsError(
          error instanceof Error ? error.message : "Failed to load local shells",
        );
        setLocalShells([]);
      })
      .finally(() => {
        if (!cancelled) setLocalShellsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [localTerminalEnabled]);

  const enabledLocalShellSet = useMemo(
    () => normalizeEnabledShells(enabledLocalShells),
    [enabledLocalShells],
  );

  const visibleLocalShells = useMemo(() => {
    const seen = new Set<string>();
    return localShells.filter((shellPath) => {
      const shellName = shellPath.split("/").pop()?.trim().toLowerCase() ?? "";
      if (!shellName || !enabledLocalShellSet.has(shellName) || seen.has(shellName)) {
        return false;
      }
      seen.add(shellName);
      return true;
    });
  }, [enabledLocalShellSet, localShells]);

  const runningDockerLocalContainers = useMemo(
    () => dockerLocalContainers.filter((container) =>
      container.state === "running" && getConfiguredContainerShells(container).length > 0
    ),
    [dockerLocalContainers],
  );
  const runningDockerRemoteContainers = useMemo(
    () => dockerRemoteContainers.filter((container) =>
      container.state === "running" && getConfiguredContainerShells(container).length > 0
    ),
    [dockerRemoteContainers],
  );
  const enabledRemoteEndpoints = useMemo(
    () =>
      remoteEndpoints
        .filter((endpoint) => endpoint.enabled && endpoint.host.trim().length > 0)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [remoteEndpoints],
  );

  const modelEntries = useMemo<ModelEntry[]>(() => {
    const entries: ModelEntry[] = [];
    if (dockerModelEnabled && dockerLocalEnabled) {
      entries.push(
        ...dockerLocalModels.map((model) => ({
          source: "docker" as const,
          environment: "local" as const,
          host: null,
          model,
        })),
      );
    }
    if (dockerModelEnabled && dockerRemoteEnabled) {
      entries.push(
        ...dockerRemoteModels.map((model) => ({
          source: "docker" as const,
          environment: "remote" as const,
          host: remoteDockerHost,
          model,
        })),
      );
    }
    if (ollamaModelEnabled && ollamaLocalEnabled) {
      entries.push(
        ...ollamaLocalModels.map((model) => ({
          source: "ollama" as const,
          environment: "local" as const,
          host: null,
          model,
        })),
      );
    }
    if (ollamaModelEnabled && ollamaRemoteEnabled) {
      entries.push(
        ...ollamaRemoteModels.map((model) => ({
          source: "ollama" as const,
          environment: "remote" as const,
          host: remoteOllamaHost,
          model,
        })),
      );
    }
    return entries;
  }, [
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
    remoteDockerHost,
    remoteOllamaHost,
  ]);

  const configuredModelTypes = useMemo(
    () =>
      MODEL_TYPE_LABELS.filter((type) =>
        modelEntries.some((entry) => Boolean(entry.model.enabledTypes[type])),
      ),
    [modelEntries],
  );

  const visibleModelEntries = useMemo(() => {
    return modelEntries.filter((entry) => {
      if (selectedModelTypes.length === 0) return true;
      return selectedModelTypes.some((type) => Boolean(entry.model.enabledTypes[type]));
    });
  }, [modelEntries, selectedModelTypes]);

  const renderContainerShellGroup = (
    container: ContainerInfo,
    dockerHost: string | null,
    environmentLabel: string,
  ) => {
    const configuredShells = getConfiguredContainerShells(container);
    return (
      <div key={container.id} className="px-2 py-1.5">
        <div className="truncate px-1 pb-1 text-[11px] text-muted-foreground">
          {container.name || container.id.slice(0, 12)}
        </div>
        <div className="space-y-1">
          {configuredShells.map((shell) => (
            <button
              key={`${container.id}:${shell.name}:${shell.command}`}
              type="button"
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted/40"
              onClick={() =>
                onSelectDescriptor({
                  kind: "shell",
                  containerId: container.id,
                  containerName: container.name || container.id.slice(0, 12),
                  label: shell.name,
                  shell: shell.command,
                  fixedLabel: true,
                  modelName: null,
                  cwd:
                    preferredShellCwdByContainerId?.[container.id]
                    ?? container.execShellWorkdir?.trim()
                    ?? null,
                  sessionId: null,
                  dockerHost,
                  ollamaHost: null,
                })}
            >
              <span>{shell.name}</span>
              <span className="text-[11px] text-muted-foreground">{environmentLabel}</span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex max-h-80 min-w-72 flex-col overflow-y-auto text-xs">
      {localTerminalEnabled ? (
        <div className="border-b border-border pb-2">
          <div className="px-2 py-1 text-[11px] text-muted-foreground">Local</div>
          {localShellsLoading ? (
            <div className="px-2 py-1.5 text-muted-foreground">Loading local shells...</div>
          ) : localShellsError ? (
            <div className="px-2 py-1.5 text-destructive">{localShellsError}</div>
          ) : visibleLocalShells.length === 0 ? (
            <div className="px-2 py-1.5 text-muted-foreground">No enabled local shells.</div>
          ) : (
            visibleLocalShells.map((shellPath) => {
              const shellName = shellPath.split("/").pop() || shellPath;
              return (
                <button
                  key={shellPath}
                  type="button"
                  className="flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-muted/40"
                  onClick={() =>
                    onSelectDescriptor({
                      kind: "local-shell",
                      containerId: "__local__",
                      containerName: "local",
                      label: shellName,
                      shell: null,
                      modelName: shellPath,
                      cwd: null,
                      sessionId: null,
                      dockerHost: null,
                      ollamaHost: null,
                    })
                  }
                >
                  <span>{shellName}</span>
                  <span className="text-[11px] text-muted-foreground">local</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}

      {enabledRemoteEndpoints.length > 0 ? (
        <div className="border-b border-border py-2">
          <div className="px-2 py-1 text-[11px] text-muted-foreground">Remote</div>
          {enabledRemoteEndpoints.map((endpoint) => (
            <button
              key={endpoint.id}
              type="button"
              className="flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-muted/40"
              onClick={() =>
                onSelectDescriptor({
                  kind: "remote-shell",
                  containerId: "__remote__",
                  containerName: "remote",
                  label: endpoint.name,
                  shell: null,
                  modelName: endpoint.host,
                  cwd: null,
                  sessionId: null,
                  dockerHost: null,
                  ollamaHost: null,
                })
              }
            >
              <span>{endpoint.name}</span>
              <span className="text-[11px] text-muted-foreground">ssh</span>
            </button>
          ))}
        </div>
      ) : null}

      {dockerLocalEnabled ? (
        <div className="border-b border-border py-2">
          <div className="px-2 py-1 text-[11px] text-muted-foreground">Docker Local</div>
          {runningDockerLocalContainers.length === 0 ? (
            <div className="px-2 py-1.5 text-muted-foreground">No running containers with configured shells.</div>
          ) : (
            runningDockerLocalContainers.map((container) =>
              renderContainerShellGroup(container, null, "container")
            )
          )}
        </div>
      ) : null}

      {dockerRemoteEnabled ? (
        <div className="border-b border-border py-2">
          <div className="px-2 py-1 text-[11px] text-muted-foreground">Docker Remote</div>
          {runningDockerRemoteContainers.length === 0 ? (
            <div className="px-2 py-1.5 text-muted-foreground">No running containers with configured shells.</div>
          ) : (
            runningDockerRemoteContainers.map((container) =>
              renderContainerShellGroup(container, remoteDockerHost, "remote")
            )
          )}
        </div>
      ) : null}

      {modelEntries.length > 0 ? (
        <div className="py-2">
          <div className="px-2 py-1 text-[11px] text-muted-foreground">AI models</div>
          {configuredModelTypes.length > 0 ? (
            <div className="flex flex-wrap gap-1 px-2 py-1">
              {configuredModelTypes.map((type) => {
                const selected = selectedModelTypes.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={[
                      "rounded border px-1.5 py-0.5 text-[11px]",
                      selected ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                    ].join(" ")}
                    onClick={() =>
                      setSelectedModelTypes((prev) =>
                        prev.includes(type)
                          ? prev.filter((entry) => entry !== type)
                          : [...prev, type],
                      )
                    }
                  >
                    {MODEL_TYPE_DISPLAY[type] ?? type}
                  </button>
                );
              })}
            </div>
          ) : null}
          {visibleModelEntries.length === 0 ? (
            <div className="px-2 py-1.5 text-muted-foreground">No matching models.</div>
          ) : (
            visibleModelEntries.map((entry) => {
              const modelName = entry.model.id.trim();
              return (
                <button
                  key={`${entry.source}:${entry.environment}:${modelName}`}
                  type="button"
                  className="flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-muted/40"
                  onClick={() =>
                    onSelectDescriptor({
                      kind: entry.source === "ollama" ? "ollama-run" : "model-run",
                      containerId: entry.source === "ollama" ? "__ollama__" : "__model-run__",
                      containerName: entry.source,
                      label: formatModelTabLabel(modelName),
                      shell: null,
                      modelName,
                      cwd: null,
                      sessionId: null,
                      dockerHost: entry.source === "docker" ? entry.host : null,
                      ollamaHost: entry.source === "ollama" ? entry.host : null,
                    })
                  }
                >
                  <span>{formatModelTabLabel(modelName)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {entry.source} {entry.environment}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
