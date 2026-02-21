import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  daemonPidPath,
  daemonSocketPath,
  type TerminalDaemonEventEnvelope,
  type TerminalDaemonMethod,
  type TerminalDaemonRequestEnvelope,
  type TerminalDaemonRequestMap,
  type TerminalDaemonResponseEnvelope,
} from "./terminalDaemonProtocol";
import type { TerminalLaunchSpec } from "../lib/terminalSessionTypes";
import { startTerminalDaemon } from "./terminal-daemon";

const DEFAULT_STATE_DIR = join(homedir(), ".context-assistant", "terminal-daemon");

type OutputListener = (sessionId: string, data: string) => void;
type ExitListener = (sessionId: string, code: number) => void;

class TerminalDaemonClient {
  private readonly stateDir: string;
  private readonly socketPath: string;
  private readonly pidPath: string;
  private inProcessFallbackStarted = false;
  private daemonVersionChecked = false;
  private outputListeners = new Set<OutputListener>();
  private exitListeners = new Set<ExitListener>();
  private subscribed = false;
  private subscribeSocket: ReturnType<typeof createConnection> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stateDir?: string) {
    this.stateDir = stateDir || DEFAULT_STATE_DIR;
    mkdirSync(this.stateDir, { recursive: true });
    this.socketPath = daemonSocketPath(this.stateDir);
    this.pidPath = daemonPidPath(this.stateDir);
  }

  private startInProcessFallback() {
    if (this.inProcessFallbackStarted) return;
    try {
      startTerminalDaemon(this.stateDir, {
        installSignalHandlers: false,
        exitOnFatal: false,
      });
      this.inProcessFallbackStarted = true;
    } catch {
      // ignore; request path still returns actionable errors
    }
  }

  private spawnDaemonIfNeeded(force = false) {
    if (!force && existsSync(this.socketPath)) return;
    if (force) {
      try {
        const rawPid = readFileSync(this.pidPath, "utf8").trim();
        const pid = Number.parseInt(rawPid, 10);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // ignore stale or inaccessible pid
          }
        }
      } catch {
        // ignore missing pid file
      }
      try {
        rmSync(this.socketPath, { force: true });
      } catch {
        // ignore stale socket cleanup errors
      }
      this.daemonVersionChecked = false;
    }
    const daemonEntryTs = join(import.meta.dir, "terminal-daemon.ts");
    const daemonEntryJs = join(import.meta.dir, "terminal-daemon.js");
    const daemonEntry = existsSync(daemonEntryTs)
      ? daemonEntryTs
      : existsSync(daemonEntryJs)
        ? daemonEntryJs
        : null;
    const bunFromPath = Bun.which("bun");
    const execBase = basename(process.execPath).toLowerCase();
    const bunCmd =
      process.env.BUN_BINARY
      ?? bunFromPath
      ?? (execBase.includes("bun") ? process.execPath : null);
    if (!bunCmd || !daemonEntry) {
      this.startInProcessFallback();
      return;
    }
    try {
      const proc = Bun.spawn([bunCmd, daemonEntry, "--state-dir", this.stateDir], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      try {
        proc.unref();
      } catch {
        // ignore
      }
    } catch {
      // If spawning is unavailable in this runtime, keep terminal features alive in-process.
      this.startInProcessFallback();
    }
  }

  private async ensureDaemonCompatible() {
    if (this.daemonVersionChecked) return;
    const probe = await this.sendRequest("ping", {});
    if (probe.version === TERMINAL_DAEMON_PROTOCOL_VERSION) {
      this.daemonVersionChecked = true;
      return;
    }
    this.spawnDaemonIfNeeded(true);
    const restarted = await this.sendRequest("ping", {});
    if (restarted.version !== TERMINAL_DAEMON_PROTOCOL_VERSION) {
      throw new Error(
        `Terminal daemon protocol mismatch: expected ${TERMINAL_DAEMON_PROTOCOL_VERSION}, got ${restarted.version}`,
      );
    }
    this.daemonVersionChecked = true;
  }

  private async sendRequest<T extends TerminalDaemonMethod>(
    method: T,
    params: TerminalDaemonRequestMap[T]["params"],
  ): Promise<TerminalDaemonRequestMap[T]["result"]> {
    this.spawnDaemonIfNeeded();
    if (method !== "ping") {
      await this.ensureDaemonCompatible();
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const envelope: TerminalDaemonRequestEnvelope<T> = { id, method, params };
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        return await new Promise((resolve, reject) => {
          const socket = createConnection({ path: this.socketPath });
          let done = false;
          let buffer = "";

          const cleanup = () => {
            if (done) return;
            done = true;
            try {
              socket.destroy();
            } catch {
              // ignore
            }
          };

          socket.setEncoding("utf8");
          socket.on("error", (error) => {
            cleanup();
            reject(error);
          });
          socket.on("connect", () => {
            socket.write(`${JSON.stringify(envelope)}\n`);
          });
          socket.on("data", (chunk) => {
            buffer += chunk;
            while (true) {
              const idx = buffer.indexOf("\n");
              if (idx < 0) break;
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              if (!line.trim()) continue;
              let parsed: TerminalDaemonResponseEnvelope | null = null;
              try {
                parsed = JSON.parse(line) as TerminalDaemonResponseEnvelope;
              } catch {
                continue;
              }
              if (!parsed || parsed.id !== id) continue;
              cleanup();
              if (parsed.ok) {
                resolve(parsed.result as TerminalDaemonRequestMap[T]["result"]);
              } else {
                reject(new Error(parsed.error));
              }
              return;
            }
          });
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ENOENT") || message.includes("ECONNREFUSED")) {
          this.spawnDaemonIfNeeded(true);
          this.startInProcessFallback();
          this.daemonVersionChecked = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Terminal daemon request failed");
  }

  private ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.connectEventStream();
  }

  private connectEventStream() {
    if (this.subscribeSocket) return;
    this.spawnDaemonIfNeeded();
    const socket = createConnection({ path: this.socketPath });
    this.subscribeSocket = socket;
    let buffer = "";
    socket.setEncoding("utf8");

    const scheduleReconnect = () => {
      this.subscribeSocket = null;
      if (!this.subscribed) return;
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectEventStream();
      }, 500);
    };

    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify({ type: "subscribe" })}\n`);
      } catch {
        scheduleReconnect();
      }
    });

    socket.on("error", () => scheduleReconnect());
    socket.on("close", () => scheduleReconnect());

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let parsed: TerminalDaemonEventEnvelope | null = null;
        try {
          parsed = JSON.parse(line) as TerminalDaemonEventEnvelope;
        } catch {
          continue;
        }
        if (!parsed || parsed.type !== "event") continue;
        if (parsed.event === "output") {
          for (const listener of this.outputListeners) listener(parsed.payload.sessionId, parsed.payload.data);
        } else if (parsed.event === "exit") {
          for (const listener of this.exitListeners) listener(parsed.payload.sessionId, parsed.payload.code);
        }
      }
    });
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    this.ensureSubscribed();
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    this.ensureSubscribed();
    return () => this.exitListeners.delete(listener);
  }

  async createSession(launchSpec: TerminalLaunchSpec, cols?: number, rows?: number, preferredSessionId?: string) {
    return await this.sendRequest("sessionCreate", { launchSpec, cols, rows, preferredSessionId });
  }

  async attachSession(sessionId: string, cols?: number, rows?: number) {
    return await this.sendRequest("sessionAttach", { sessionId, cols, rows });
  }

  async detachSession(sessionId: string) {
    return await this.sendRequest("sessionDetach", { sessionId });
  }

  async listSessions() {
    return await this.sendRequest("sessionList", {});
  }

  async sessionInput(sessionId: string, data: string) {
    return await this.sendRequest("sessionInput", { sessionId, data });
  }

  async sessionResize(sessionId: string, cols: number, rows: number) {
    return await this.sendRequest("sessionResize", { sessionId, cols, rows });
  }

  async sessionDestroy(sessionId: string) {
    return await this.sendRequest("sessionDestroy", { sessionId });
  }

  async sessionDestroyMany(sessionIds: string[]) {
    return await this.sendRequest("sessionDestroyMany", { sessionIds });
  }

  async listLocalShells() {
    return await this.sendRequest("listLocalShells", {});
  }
}

const clients = new Map<string, TerminalDaemonClient>();

export function getTerminalDaemonClient(stateDir?: string): TerminalDaemonClient {
  const key = stateDir || DEFAULT_STATE_DIR;
  const existing = clients.get(key);
  if (existing) return existing;
  const created = new TerminalDaemonClient(key);
  clients.set(key, created);
  return created;
}
