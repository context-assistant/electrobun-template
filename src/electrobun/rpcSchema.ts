import type { ContainerShell } from "../lib/containerShells";

export type UpdateInfo = {
  version: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
};

// ---------------------------------------------------------------------------
// Docker types (shared between Bun backend and webview)
// ---------------------------------------------------------------------------

export type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  mounts: string;
  readOnly: boolean;
  rootUser: boolean;
  netHost: boolean;
  hasMappedPorts: boolean;
  dockerSock: boolean;
  sshAgent: boolean;
  containerShells?: ContainerShell[];
  /** Optional shell command used for terminal-tab `docker exec` sessions. */
  execCommandShell?: string;
  /** Optional working directory override for terminal-tab `docker exec` sessions. */
  execShellWorkdir?: string;
  composeProject: string;
  networks: string[];
};

export type ContainerStats = {
  containerId: string;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
};

export type PortBinding = { hostIp: string; hostPort: string };

export type ContainerInspect = {
  id: string;
  name: string;
  image: string;
  state: {
    status: string;
    running: boolean;
    startedAt: string;
    finishedAt: string;
  };
  config: {
    env: string[];
    cmd: string[];
    entrypoint: string[] | null;
    /** Effective user for container PID1 (from `docker create --user` or image USER). */
    user: string;
    image: string;
    /** Docker Config.WorkingDir */
    workingDir: string;
    /** Paths declared via Dockerfile `VOLUME` (derived from Config.Volumes). */
    volumes: string[];
    labels: Record<string, string>;
  };
  hostConfig: {
    readOnly: boolean;
    networkMode: string;
    portBindings: Record<string, PortBinding[] | null>;
    gpusAll: boolean;
  };
  mounts: Array<{
    type: string;
    name: string;
    source: string;
    destination: string;
    rw: boolean;
  }>;
  networkSettings: {
    ports: Record<string, PortBinding[] | null>;
  };
};

export type VolumeInfo = {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
};

export type ImageInfo = {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
};

export type NetworkInfo = {
  id: string;
  name: string;
  driver: string;
  scope: string;
  createdAt: string;
};

export type AIModelInfo = {
  name: string;
  id: string;
  size: string;
  modifiedAt: string;
  status: string;
  running: boolean;
};

export type OllamaModelInfo = {
  name: string;
  id: string;
  size: string;
  modifiedAt: string;
  running: boolean;
};

export type FileEntry = {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
  permissions: string;
};

export type DockerUploadEntry = {
  relativePath: string;
  kind: "file" | "directory";
  contentBase64?: string;
};

export type CreateContainerParams = {
  image: string;
  name?: string;
  ports?: Array<{ host: number; container: number; protocol?: string }>;
  env?: Record<string, string>;
  volumes?: Array<{ volume: string; containerPath: string }>;
  command?: string[];
  containerShells?: ContainerShell[];
  /** Optional shell command used for terminal-tab `docker exec` sessions. */
  execCommandShell?: string;
  /** Optional working directory override for terminal-tab `docker exec` sessions. */
  execShellWorkdir?: string;
  /** Container working directory (`docker create -w`). */
  workdir?: string;
  readOnly?: boolean;
  /** If true, mounts tmpfs at /tmp (equivalent to `--tmpfs /tmp:rw`). */
  tmpfsTmp?: boolean;
  mountDockerSocket?: boolean;
  memoryLimit?: string;
  cpuLimit?: string;
  restartPolicy?: string;
  netHost?: boolean;
  gpusAll?: boolean;
  rootUser?: boolean;
  /** Preferred user for terminal sessions (`docker exec -u`). */
  execUser?: string;
  sshAgent?: boolean;
  gitConfig?: boolean;
  /**
   * Advanced override for SSH agent socket bind source.
   * Path is resolved on the Docker daemon host.
   */
  sshAgentHostSocketPath?: string;
  /**
   * Advanced override for gitconfig bind source.
   * Path is resolved on the Docker daemon host.
   */
  gitConfigHostPath?: string;
};

// ---------------------------------------------------------------------------
// RPC Schema
// ---------------------------------------------------------------------------

export type AppRPCSchema = {
  bun: {
    requests: {
      // Updater
      updater_checkForUpdate: {
        params: {};
        response: UpdateInfo;
      };
      updater_downloadUpdate: {
        params: {};
        response: UpdateInfo;
      };
      updater_applyUpdate: {
        params: {};
        response: { ok: true };
      };
      updater_getUpdateInfo: {
        params: {};
        response: UpdateInfo | null;
      };

      // Secrets
      secrets_get: {
        params: { key: string };
        response: { value: string | null };
      };
      secrets_set: {
        params: { key: string; value: string };
        response: { ok: true };
      };
      secrets_delete: {
        params: { key: string };
        response: { ok: boolean };
      };

      // App data storage (file-based, shared across instances)
      storage_get: {
        params: { key: string };
        response: { value: string | null };
      };
      storage_set: {
        params: { key: string; value: string };
        response: { ok: true };
      };
      storage_remove: {
        params: { key: string };
        response: { ok: true };
      };
      storage_getAll: {
        params: {};
        response: { data: Record<string, string> };
      };
      storage_clear: {
        params: {};
        response: { ok: true };
      };
      storage_resetWindowState: {
        params: {};
        response: { ok: true };
      };

      modelProvider_httpRequest: {
        params: {
          url: string;
          method?: "GET" | "POST";
          headers?: Record<string, string>;
          body?: string;
        };
        response: {
          ok: boolean;
          status: number;
          json: unknown | null;
          text: string;
        };
      };

      // Docker: availability
      docker_available: {
        params: {};
        response: { available: boolean };
      };
      docker_setHost: {
        params: { dockerHost: string | null };
        response: { ok: true };
      };

      // Docker: container operations
      docker_listContainers: {
        params: {};
        response: { containers: ContainerInfo[] };
      };
      docker_createContainer: {
        params: CreateContainerParams;
        response: { containerId: string };
      };
      docker_startContainer: {
        params: { containerId: string };
        response: { ok: true };
      };
      docker_stopContainer: {
        params: { containerId: string };
        response: { ok: true };
      };
      docker_removeContainer: {
        params: { containerId: string; force?: boolean };
        response: { ok: true };
      };
      docker_inspectContainer: {
        params: { containerId: string };
        response: ContainerInspect;
      };
      docker_containerStats: {
        params: { containerId: string };
        response: ContainerStats;
      };
      docker_containerLogs: {
        params: { containerId: string; tail?: number };
        response: { logs: string };
      };
      docker_containerExec: {
        params: { containerId: string; command: string[] };
        response: { exitCode: number; stdout: string; stderr: string };
      };
      docker_containerExecAs: {
        params: { containerId: string; user: string; command: string[] };
        response: { exitCode: number; stdout: string; stderr: string };
      };

      // Docker: volume operations
      docker_listVolumes: {
        params: {};
        response: { volumes: VolumeInfo[] };
      };
      docker_createVolume: {
        params: { name: string };
        response: VolumeInfo;
      };
      docker_removeVolume: {
        params: { name: string };
        response: { ok: true };
      };
      docker_inspectVolume: {
        params: { name: string };
        response: VolumeInfo;
      };
      docker_installBashDevToolsVolume: {
        params: { volumeName: string; scope: "root" | "home" };
        response: { homesInstalled: number };
      };

      // Docker: network operations
      docker_listNetworks: {
        params: {};
        response: { networks: NetworkInfo[] };
      };
      docker_removeNetwork: {
        params: { name: string };
        response: { ok: true };
      };
      docker_listAiModels: {
        params: {};
        response: { models: AIModelInfo[] };
      };
      docker_removeAiModel: {
        params: { name: string };
        response: { ok: true };
      };
      docker_unloadAiModel: {
        params: { name: string };
        response: { ok: true };
      };

      // Docker: file operations (via docker exec)
      docker_listFiles: {
        params: { containerId: string; path: string };
        response: { entries: FileEntry[] };
      };
      docker_readFile: {
        params: { containerId: string; path: string };
        response: { content: string };
      };
      docker_readFileBase64: {
        params: { containerId: string; path: string };
        response: { contentBase64: string };
      };
      docker_writeFile: {
        params: { containerId: string; path: string; content: string };
        response: { ok: true };
      };
      docker_createDirectory: {
        params: { containerId: string; path: string };
        response: { ok: true };
      };
      docker_deleteFile: {
        params: { containerId: string; path: string };
        response: { ok: true };
      };
      docker_renameFile: {
        params: { containerId: string; oldPath: string; newPath: string };
        response: { ok: true };
      };
      docker_importFiles: {
        params: {
          containerId: string;
          targetDirectory: string;
          entries: DockerUploadEntry[];
        };
        response: { ok: true };
      };

      // Docker: image operations
      docker_listImages: {
        params: {};
        response: { images: ImageInfo[] };
      };
      docker_removeImage: {
        params: { image: string; force?: boolean };
        response: { ok: true };
      };
      docker_pruneDanglingImages: {
        params: {};
        response: { ok: true };
      };
      docker_imageUsers: {
        params: { image: string };
        response: { users: string[] };
      };
      docker_buildImage: {
        params: { dockerfile: string; tag: string };
        response: { output: string };
      };
      docker_commitContainer: {
        params: { containerId: string; image: string };
        response: { imageId: string };
      };
      docker_imageDeclaredVolumes: {
        params: { image: string };
        response: { volumes: string[] };
      };

      // Docker: volume attachment (recreates container with volume mounted)
      docker_attachVolume: {
        params: { containerId: string; volumeName: string; mountPath?: string };
        response: { newContainerId: string };
      };
      // Docker: recreate container with writable root filesystem
      docker_recreateWritable: {
        params: { containerId: string };
        response: { newContainerId: string };
      };

      // Docker: terminal operations
      docker_listLocalShells: {
        params: {};
        response: { shells: string[] };
      };
      docker_terminalCreate: {
        params: { containerId: string; shell?: string; cols?: number; rows?: number; cwd?: string; dockerHost?: string | null };
        response: { sessionId: string; shell: string };
      };
      docker_terminalCreateLocal: {
        params: { shell?: string; cols?: number; rows?: number };
        response: { sessionId: string; shell: string };
      };
      docker_terminalCreateSsh: {
        params: { sshHost: string; cols?: number; rows?: number };
        response: { sessionId: string; shell: string };
      };
      docker_terminalCreateModelRun: {
        params: { modelName: string; cols?: number; rows?: number; dockerHost?: string | null };
        response: { sessionId: string; shell: string };
      };
      docker_terminalCreateDockerRun: {
        params: { image: string; args?: string[]; cols?: number; rows?: number; dockerHost?: string | null };
        response: { sessionId: string; shell: string };
      };
      docker_terminalCreateImagePull: {
        params: { imageName: string; cols?: number; rows?: number; dockerHost?: string | null };
        response: { sessionId: string; shell: string };
      };
      docker_terminalCreateModelPull: {
        params: { modelName: string; cols?: number; rows?: number; dockerHost?: string | null };
        response: { sessionId: string; shell: string };
      };
      docker_terminalAttach: {
        params: { sessionId: string; cols?: number; rows?: number };
        response: { ok: true; shell: string; recentOutput: string };
      };
      docker_terminalList: {
        params: {};
        response: {
          sessions: Array<{
            sessionId: string;
            launchSpec: unknown;
            shell: string;
            status: "running" | "exited";
            createdAt: number;
            updatedAt: number;
            cols: number;
            rows: number;
          }>;
        };
      };
      docker_terminalInput: {
        params: { sessionId: string; data: string };
        response: { ok: true };
      };
      docker_terminalResize: {
        params: { sessionId: string; cols: number; rows: number };
        response: { ok: true };
      };
      docker_terminalDestroy: {
        params: { sessionId: string };
        response: { ok: true };
      };
      docker_terminalDestroyMany: {
        params: { sessionIds: string[] };
        response: { ok: true };
      };
      docker_subscribeContainers: {
        params: {};
        response: { ok: true };
      };
      docker_unsubscribeContainers: {
        params: {};
        response: { ok: true };
      };
      docker_subscribeLogs: {
        params: { containerId: string; tail?: number };
        response: { ok: true };
      };
      docker_unsubscribeLogs: {
        params: { containerId: string };
        response: { ok: true };
      };

      // Ollama
      ollama_available: {
        params: {};
        response: { available: boolean };
      };
      ollama_setHost: {
        params: { ollamaHost: string | null };
        response: { ok: true };
      };
      ollama_listModels: {
        params: {};
        response: { models: OllamaModelInfo[] };
      };
      ollama_removeModel: {
        params: { name: string };
        response: { ok: true };
      };
      ollama_unloadModel: {
        params: { name: string };
        response: { ok: true };
      };
      ollama_terminalCreateModelRun: {
        params: { modelName: string; cols?: number; rows?: number; ollamaHost?: string | null };
        response: { sessionId: string; shell: string };
      };
      ollama_terminalCreatePull: {
        params: { modelName: string; cols?: number; rows?: number; ollamaHost?: string | null };
        response: { sessionId: string; shell: string };
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      updater_updateInfoChanged: UpdateInfo;
      docker_terminalOutput: { sessionId: string; data: string };
      docker_terminalExit: { sessionId: string; code: number };
      docker_containersChanged: { containers: ContainerInfo[] };
      docker_logData: { containerId: string; data: string };
    };
  };
};
