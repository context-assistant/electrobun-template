import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import * as ollamaClient from "../lib/ollama";
import type { AIModelInfo, ContainerInfo, ContainerInspect, OllamaModelInfo } from "../electrobun/rpcSchema";

export type InspectModelTarget = {
  source: "docker" | "ollama";
  modelName: string;
};

type Props = {
  containerId: string | null;
  modelTarget?: InspectModelTarget | null;
  containers: ContainerInfo[];
  visible: boolean;
  dockerHost?: string | null;
};

function stateColor(state: string) {
  if (state === "running") return "text-emerald-500";
  if (state === "exited") return "text-red-400";
  if (state === "created") return "text-amber-400";
  if (state === "paused") return "text-yellow-500";
  return "text-muted-foreground";
}

export function ContainerInspectTab({
  containerId,
  modelTarget = null,
  containers,
  visible,
  dockerHost = null,
}: Props) {
  const [data, setData] = useState<ContainerInspect | null>(null);
  const [dockerModel, setDockerModel] = useState<AIModelInfo | null>(null);
  const [ollamaModel, setOllamaModel] = useState<OllamaModelInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelTargetName = modelTarget?.modelName.trim() ?? "";
  const hasModelTarget = modelTargetName.length > 0;

  const containerLabel = useMemo(() => {
    if (!containerId) return null;
    const c = containers.find((x) => x.id === containerId);
    return c?.name ?? containerId.slice(0, 12);
  }, [containerId, containers]);

  const refresh = useCallback(async () => {
    if (hasModelTarget) {
      setLoading(true);
      setError(null);
      try {
        const [dockerModels, ollamaModels] = await Promise.all([
          dockerClient.runWithDockerHost(dockerHost, async () => await dockerClient.listAiModels()),
          ollamaClient.listModels(),
        ]);
        const normalized = modelTargetName.toLowerCase();
        const dockerMatch = dockerModels.find((m) => m.name.toLowerCase() === normalized) ?? null;
        const ollamaMatch = ollamaModels.find((m) => m.name.toLowerCase() === normalized) ?? null;
        setDockerModel(dockerMatch);
        setOllamaModel(ollamaMatch);
        setData(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to inspect model");
        setDockerModel(null);
        setOllamaModel(null);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!containerId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await dockerClient.runWithDockerHost(
        dockerHost,
        async () => await dockerClient.inspectContainer(containerId),
      );
      setData(next);
      setDockerModel(null);
      setOllamaModel(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to inspect container");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [containerId, dockerHost, hasModelTarget, modelTargetName]);

  useEffect(() => {
    if (!visible) return;
    if (!containerId && !hasModelTarget) {
      setData(null);
      setDockerModel(null);
      setOllamaModel(null);
      setError(null);
      return;
    }
    void refresh();
  }, [containerId, hasModelTarget, refresh, visible]);

  if (!containerId && !hasModelTarget) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        Select a container or model to inspect.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1 bg-background shrink-0">
        <div className="text-xs text-muted-foreground truncate mr-auto">
          {hasModelTarget ? (
            <>
              Inspect model: <span className="text-foreground font-medium">{modelTargetName}</span>
              {modelTarget ? (
                <span className="text-muted-foreground/80"> ({modelTarget.source})</span>
              ) : null}
            </>
          ) : (
            <>
              Inspect: <span className="text-foreground font-medium">{containerLabel}</span>
            </>
          )}
          {error ? ` — ${error}` : ""}
        </div>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <IconButton label="Refresh inspect" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="h-3 w-3" />
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {!data ? (
          hasModelTarget ? (
            <div className="space-y-3 text-xs">
              {!dockerModel && !ollamaModel && !loading ? (
                <div className="text-muted-foreground">Model not found in Docker or Ollama.</div>
              ) : null}
              {dockerModel ? (
                <>
                  <div className="rounded border bg-muted/20 p-2 space-y-1">
                    <div className="font-medium text-foreground">Docker model</div>
                    <div>
                      <span className="font-medium text-foreground">Status: </span>
                      <span className={dockerModel.running ? "text-emerald-500" : "text-muted-foreground"}>
                        {dockerModel.status || (dockerModel.running ? "running" : "available")}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Name: </span>
                      <span className="text-muted-foreground">{dockerModel.name}</span>
                    </div>
                    {dockerModel.size ? (
                      <div>
                        <span className="font-medium text-foreground">Size: </span>
                        <span className="text-muted-foreground">{dockerModel.size}</span>
                      </div>
                    ) : null}
                    {dockerModel.modifiedAt ? (
                      <div>
                        <span className="font-medium text-foreground">Modified: </span>
                        <span className="text-muted-foreground">{dockerModel.modifiedAt}</span>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                null
              )}

              {ollamaModel ? (
                <>
                  <div className="rounded border bg-muted/20 p-2 space-y-1">
                    <div className="font-medium text-foreground">Ollama model</div>
                    <div>
                      <span className="font-medium text-foreground">Status: </span>
                      <span className={ollamaModel.running ? "text-emerald-500" : "text-muted-foreground"}>
                        {ollamaModel.running ? "running" : "available"}
                      </span>
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Name: </span>
                      <span className="text-muted-foreground">{ollamaModel.name}</span>
                    </div>
                    {ollamaModel.size ? (
                      <div>
                        <span className="font-medium text-foreground">Size: </span>
                        <span className="text-muted-foreground">{ollamaModel.size}</span>
                      </div>
                    ) : null}
                    {ollamaModel.modifiedAt ? (
                      <div>
                        <span className="font-medium text-foreground">Modified: </span>
                        <span className="text-muted-foreground">{ollamaModel.modifiedAt}</span>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                null
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {loading ? "Loading..." : "No data."}
            </div>
          )
        ) : (
          <div className="space-y-3 text-xs">
            <div>
              <span className="font-medium text-foreground">ID: </span>
              <span className="text-muted-foreground font-mono">{data.id.slice(0, 12)}</span>
            </div>
            <div>
              <span className="font-medium text-foreground">Image: </span>
              <span className="text-muted-foreground">{data.image}</span>
            </div>
            <div>
              <span className="font-medium text-foreground">Status: </span>
              <span className={stateColor(data.state.status)}>
                {data.state.status}
              </span>
            </div>
            {data.state.running && (
              <div>
                <span className="font-medium text-foreground">Started: </span>
                <span className="text-muted-foreground">{data.state.startedAt}</span>
              </div>
            )}
            {data.config.cmd.length > 0 && (
              <div>
                <span className="font-medium text-foreground">Command: </span>
                <span className="text-muted-foreground font-mono">
                  {data.config.cmd.join(" ")}
                </span>
              </div>
            )}
            {data.mounts.length > 0 && (
              <div>
                <div className="font-medium text-foreground mb-1">Mounts:</div>
                <ul className="pl-3 space-y-0.5">
                  {data.mounts.map((m, i) => (
                    <li key={i} className="text-muted-foreground font-mono">
                      {m.name || m.source} → {m.destination} ({m.type}, {m.rw ? "rw" : "ro"})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.config.env.length > 0 && (
              <div>
                <div className="font-medium text-foreground mb-1">Environment:</div>
                <pre className="rounded border bg-muted/30 p-2 text-[10px] max-h-56 overflow-auto">
                  {data.config.env.join("\n")}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

