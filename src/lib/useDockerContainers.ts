import { useCallback, useEffect, useRef, useState } from "react";
import { onContainersChanged } from "../electrobun/renderer";
import type { ContainerInfo } from "../electrobun/rpcSchema";
import * as dockerClient from "./docker";

type State = {
  dockerAvailable: boolean | null;
  containers: ContainerInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Container list watcher.
 *
 * - When enabled: receives updates via websocket/RPC push.
 * - When disabled: clears state and stops all integration calls.
 */
export function useDockerContainers(enabled = true, dockerHost: string | null = null): State {
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestSeqRef.current;
    const isCurrent = () => requestSeqRef.current === requestId;

    if (!enabled) {
      if (!isCurrent()) return;
      setError(null);
      setLoading(false);
      setDockerAvailable(false);
      setContainers([]);
      return;
    }
    if (isCurrent()) {
      setError(null);
      setLoading(true);
    }
    try {
      await dockerClient.runWithDockerHost(dockerHost, async () => {
        if (!isCurrent()) return;
        const next = await dockerClient.listContainers();
        if (!isCurrent()) return;
        setDockerAvailable(true);
        setContainers(next);
      });
    } catch (e) {
      if (!isCurrent()) return;
      const message = e instanceof Error ? e.message : "Failed to list containers";
      const lower = message.toLowerCase();
      const definitelyUnavailable =
        lower.includes("cannot connect to the docker daemon")
        || lower.includes("error during connect")
        || lower.includes("is the docker daemon running")
        || lower.includes("dial unix")
        || lower.includes("connect: permission denied")
        || lower.includes("docker socket not found")
        || lower.includes("timed out while syncing host context");
      setDockerAvailable(definitelyUnavailable ? false : null);
      setError(message);
    } finally {
      if (!isCurrent()) return;
      setLoading(false);
    }
  }, [dockerHost, enabled]);

  useEffect(() => {
    if (!enabled) {
      setError(null);
      setLoading(false);
      setDockerAvailable(false);
      setContainers([]);
      return;
    }
    void refresh();
    const unsub = onContainersChanged(() => {
      // Container push payload is global and not host-scoped.
      // Re-read using this hook's configured host for correctness.
      void refresh();
    });
    const onDockerHostReload = () => {
      void refresh();
    };
    window.addEventListener("context-assistant:docker-host-reload", onDockerHostReload);
    return () => {
      requestSeqRef.current += 1;
      unsub();
      window.removeEventListener("context-assistant:docker-host-reload", onDockerHostReload);
    };
  }, [enabled, refresh]);

  return { dockerAvailable, containers, loading, error, refresh };
}

