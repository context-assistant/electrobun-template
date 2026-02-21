import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { CustomSelect } from "./CustomSelect";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import { onLogStream, subscribeLogStream, unsubscribeLogStream } from "../electrobun/renderer";
import type { ContainerInfo } from "../electrobun/rpcSchema";

type Props = {
  containers: ContainerInfo[];
  selectedContainerId: string | null;
  onSelectContainerId: (containerId: string | null) => void;
  visible: boolean;
  dockerHost?: string | null;
  /** Number of log lines to fetch (tail). */
  tailLines?: number;
  /** Legacy prop kept for compatibility (streaming is push-based now). */
  autoRefreshMs?: number;
};

/** Max accumulated log length before truncation (keep the tail). */
const MAX_LOG_LENGTH = 512_000;

export function ContainerLogsTab({
  containers,
  selectedContainerId,
  onSelectContainerId,
  visible,
  dockerHost = null,
  tailLines = 500,
}: Props) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);

  const sortedContainers = useMemo(() => {
    return containers
      .slice()
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }, [containers]);

  const selectedLabel = useMemo(() => {
    if (!selectedContainerId) return null;
    const c = containers.find((x) => x.id === selectedContainerId);
    if (!c) return selectedContainerId.slice(0, 12);
    return `${c.name || c.id.slice(0, 12)} (${c.state})`;
  }, [containers, selectedContainerId]);

  const fetchLogs = useCallback(async () => {
    if (!selectedContainerId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await dockerClient.runWithDockerHost(
        dockerHost,
        async () => await dockerClient.getContainerLogs(selectedContainerId, tailLines),
      );
      setLogs(result);
      setAutoScroll(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch logs";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [dockerHost, selectedContainerId, tailLines]);

  const clear = useCallback(() => {
    setLogs("");
    setError(null);
    setAutoScroll(true);
  }, []);

  const displayLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    const lines = logs.split("\n");
    const matched = lines.filter((line) => line.toLowerCase().includes(q));
    return matched.join("\n");
  }, [logs, search]);

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    if (!visible) return;
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayLogs, autoScroll, visible]);

  // Real-time log streaming (WebSocket in dev, RPC push in Electrobun)
  useEffect(() => {
    if (!visible) return;
    if (!selectedContainerId) {
      setLogs("");
      setError(null);
      return;
    }

    setLogs("");
    setLoading(true);
    subscribeLogStream(selectedContainerId, tailLines);

    const unsub = onLogStream((containerId, data) => {
      if (containerId !== selectedContainerId) return;
      setLoading(false);
      setLogs((prev) => {
        const next = prev + data;
        if (next.length > MAX_LOG_LENGTH) {
          const trimPoint = next.indexOf("\n", next.length - MAX_LOG_LENGTH);
          return trimPoint > 0 ? next.slice(trimPoint + 1) : next.slice(-MAX_LOG_LENGTH);
        }
        return next;
      });
    });

    return () => {
      unsub();
      unsubscribeLogStream(selectedContainerId);
    };
  }, [selectedContainerId, tailLines, visible]);

  // Keep one-shot fetching for manual refresh support.

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-2 py-1 bg-background shrink-0">
        <CustomSelect
          value={selectedContainerId ?? ""}
          onChange={(next) => {
            onSelectContainerId(next || null);
            setSearch("");
            setAutoScroll(true);
          }}
          options={[
            { value: "", label: "Select container…" },
            ...sortedContainers.map((c) => ({
              value: c.id,
              label: `${(c.name || c.id.slice(0, 12)).trim()} · ${c.state} · ${c.id.slice(0, 12)}`,
            })),
          ]}
          className="h-8 shrink-0 max-w-[320px] rounded-md px-2 text-xs"
        />

        <input
          type="search"
          className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs text-foreground"
          placeholder="Search logs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={!selectedContainerId}
        />

        <span className="text-[11px] text-muted-foreground truncate max-w-[260px] hidden sm:inline">
          {selectedLabel ? `Logs: ${selectedLabel}` : "Logs"}
          {error ? ` — ${error}` : ""}
        </span>

        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <IconButton
          label="Refresh logs"
          onClick={() => void fetchLogs()}
          disabled={!selectedContainerId || loading}
        >
          <RefreshCw className="h-3 w-3" />
        </IconButton>
        <IconButton
          label="Clear logs"
          onClick={clear}
          disabled={!selectedContainerId || loading || logs.length === 0}
        >
          <Trash2 className="h-3 w-3" />
        </IconButton>
      </div>

      {!selectedContainerId ? (
        <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
          Select a container to view logs.
        </div>
      ) : (
        <pre
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto p-2 text-xs font-mono whitespace-pre-wrap break-all bg-[#1e1e1e] text-[#d4d4d4] select-text"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            if (autoScroll && !atBottom) {
              setAutoScroll(false);
            } else if (!autoScroll && atBottom) {
              setAutoScroll(true);
            }
          }}
        >
          {displayLogs || (loading ? "Loading logs..." : search.trim() ? "No matches." : "No logs yet.")}
        </pre>
      )}
    </div>
  );
}

