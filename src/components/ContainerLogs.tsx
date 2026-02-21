import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ArrowDown } from "lucide-react";
import { IconButton } from "./IconButton";
import * as dockerClient from "../lib/docker";
import { onLogStream, subscribeLogStream, unsubscribeLogStream } from "../electrobun/renderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  activeContainerId: string | null;
  /** Number of log lines to fetch (tail). */
  tailLines?: number;
  /** Legacy prop kept for compatibility (streaming is push-based now). */
  autoRefreshMs?: number;
};

/** Max accumulated log length before truncation (keep the tail). */
const MAX_LOG_LENGTH = 512_000;

// ---------------------------------------------------------------------------
// ContainerLogs
// ---------------------------------------------------------------------------

export function ContainerLogs({
  activeContainerId,
  tailLines = 500,
}: Props) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);
  const fetchSeqRef = useRef(0);

  // HTTP fetch for manual refresh and Electrobun polling fallback
  const fetchLogs = useCallback(async () => {
    const containerId = activeContainerId;
    if (!containerId) return;
    const fetchId = ++fetchSeqRef.current;
    const isCurrent = () => fetchSeqRef.current === fetchId;
    if (isCurrent()) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await dockerClient.getContainerLogs(containerId, tailLines);
      if (!isCurrent()) return;
      setLogs(result);
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof Error ? err.message : "Failed to fetch logs";
      setError(msg);
    } finally {
      if (!isCurrent()) return;
      setLoading(false);
    }
  }, [activeContainerId, tailLines]);

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Real-time log streaming (WebSocket in dev, RPC push in Electrobun)
  useEffect(() => {
    fetchSeqRef.current += 1;
    if (!activeContainerId) {
      setLogs("");
      setError(null);
      return;
    }
    setLogs("");
    setLoading(true);
    subscribeLogStream(activeContainerId, tailLines);

    const unsub = onLogStream((containerId, data) => {
      if (containerId === activeContainerId) {
        setLoading(false);
        setLogs((prev) => {
          const next = prev + data;
          // Truncate from the front if the buffer grows too large
          if (next.length > MAX_LOG_LENGTH) {
            const trimPoint = next.indexOf("\n", next.length - MAX_LOG_LENGTH);
            return trimPoint > 0 ? next.slice(trimPoint + 1) : next.slice(-MAX_LOG_LENGTH);
          }
          return next;
        });
      }
    });

    return () => {
      unsub();
      unsubscribeLogStream(activeContainerId);
    };
  }, [activeContainerId, tailLines]);

  // Keep a one-shot fetch entrypoint for manual refresh.

  if (!activeContainerId) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        Select a container in the Environment tab to view logs.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background shrink-0">
        <span className="text-xs text-muted-foreground truncate mr-auto">
          Logs: {activeContainerId.slice(0, 12)}
          {error ? ` — ${error}` : ""}
        </span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <IconButton
          label={autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
          onClick={() => setAutoScroll((prev) => !prev)}
        >
          <ArrowDown
            className={`h-3 w-3 ${autoScroll ? "text-blue-400" : "text-muted-foreground"}`}
          />
        </IconButton>
        <IconButton
          label="Refresh logs"
          onClick={() => void fetchLogs()}
          disabled={loading}
        >
          <RefreshCw className="h-3 w-3" />
        </IconButton>
      </div>
      {/* Log output */}
      <pre
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-auto p-2 text-xs font-mono whitespace-pre-wrap break-all bg-[#1e1e1e] text-[#d4d4d4] select-text"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          if (autoScroll && !atBottom) {
            setAutoScroll(false);
          }
        }}
      >
        {logs || (loading ? "Loading logs..." : "No logs yet.")}
      </pre>
    </div>
  );
}
