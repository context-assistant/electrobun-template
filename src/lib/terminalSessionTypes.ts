export type TerminalRunnerKind =
  | "local"
  | "ssh"
  | "docker-exec"
  | "docker-run"
  | "ollama-run"
  | "docker-model-run"
  | "ollama-pull"
  | "docker-image-pull"
  | "docker-model-pull";

export type TerminalLaunchSpec =
  | {
    kind: "local";
    shell?: string;
  }
  | {
    kind: "ssh";
    sshHost: string;
  }
  | {
    kind: "docker-exec";
    containerId: string;
    shell?: string;
    cwd?: string;
    dockerHost?: string | null;
  }
  | {
    kind: "docker-run";
    image: string;
    args?: string[];
    dockerHost?: string | null;
  }
  | {
    kind: "ollama-run";
    modelName: string;
    ollamaHost?: string | null;
  }
  | {
    kind: "docker-model-run";
    modelName: string;
    dockerHost?: string | null;
  }
  | {
    kind: "ollama-pull";
    modelName: string;
    ollamaHost?: string | null;
  }
  | {
    kind: "docker-image-pull";
    imageName: string;
    dockerHost?: string | null;
  }
  | {
    kind: "docker-model-pull";
    modelName: string;
    dockerHost?: string | null;
  };

export type TerminalSessionStatus = "running" | "exited";

export type TerminalSessionRecord = {
  sessionId: string;
  launchSpec: TerminalLaunchSpec;
  shell: string;
  status: TerminalSessionStatus;
  createdAt: number;
  updatedAt: number;
  cols: number;
  rows: number;
};

export type TerminalSessionCreateResult = {
  sessionId: string;
  shell: string;
  reused: boolean;
};
