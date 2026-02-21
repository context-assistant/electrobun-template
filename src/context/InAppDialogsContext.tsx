import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export type InAppPromptRequest = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  actionLabel?: string;
  onAction?: (value: string) => void | Promise<void>;
};

export type InAppConfirmRequest = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type InAppPromptState = InAppPromptRequest & {
  value: string;
  resolve: (value: string | null) => void;
};

type InAppConfirmState = InAppConfirmRequest & {
  resolve: (value: boolean) => void;
};

type ContextValue = {
  askPrompt: (request: InAppPromptRequest) => Promise<string | null>;
  askConfirm: (request: InAppConfirmRequest) => Promise<boolean>;
};

const InAppDialogsContext = createContext<ContextValue | null>(null);

export function useInAppDialogs(): ContextValue {
  const ctx = useContext(InAppDialogsContext);
  if (!ctx) {
    throw new Error("useInAppDialogs must be used within InAppDialogsProvider");
  }
  return ctx;
}

export function useInAppDialogsOptional(): ContextValue | null {
  return useContext(InAppDialogsContext);
}

type ProviderProps = {
  children: ReactNode;
};

export function InAppDialogsProvider({ children }: ProviderProps) {
  const [promptState, setPromptState] = useState<InAppPromptState | null>(null);
  const [confirmState, setConfirmState] = useState<InAppConfirmState | null>(null);

  const askPrompt = useCallback((request: InAppPromptRequest) => {
    return new Promise<string | null>((resolve) => {
      setPromptState({ ...request, value: request.defaultValue ?? "", resolve });
    });
  }, []);

  const askConfirm = useCallback((request: InAppConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...request, resolve });
    });
  }, []);

  const dialogs = (
    <>
      {promptState && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Cancel"
            onClick={() => {
              promptState.resolve(null);
              setPromptState(null);
            }}
          />
          <div className="relative z-[91] w-full max-w-md rounded-md border bg-background p-4 shadow-xl">
            <div className="text-sm font-semibold text-foreground">{promptState.title}</div>
            {promptState.message && (
              <div className="mt-1 text-xs text-muted-foreground">{promptState.message}</div>
            )}
            <input
              autoFocus
              className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
              value={promptState.value}
              placeholder={promptState.placeholder}
              onChange={(e) =>
                setPromptState((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  promptState.resolve(promptState.value);
                  setPromptState(null);
                } else if (e.key === "Escape") {
                  promptState.resolve(null);
                  setPromptState(null);
                }
              }}
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              {promptState.actionLabel && promptState.onAction && (
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                  onClick={() => {
                    void promptState.onAction?.(promptState.value);
                  }}
                >
                  {promptState.actionLabel}
                </button>
              )}
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                onClick={() => {
                  promptState.resolve(null);
                  setPromptState(null);
                }}
              >
                {promptState.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className="rounded-md border border-primary bg-primary/15 px-3 py-1.5 text-xs text-primary"
                onClick={() => {
                  promptState.resolve(promptState.value);
                  setPromptState(null);
                }}
              >
                {promptState.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmState && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Cancel"
            onClick={() => {
              confirmState.resolve(false);
              setConfirmState(null);
            }}
          />
          <div className="relative z-[91] w-full max-w-md rounded-md border bg-background p-4 shadow-xl">
            <div className="text-sm font-semibold text-foreground">{confirmState.title}</div>
            {confirmState.message && (
              <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap">
                {confirmState.message}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                onClick={() => {
                  confirmState.resolve(false);
                  setConfirmState(null);
                }}
              >
                {confirmState.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={[
                  "rounded-md border px-3 py-1.5 text-xs",
                  confirmState.danger
                    ? "border-destructive bg-destructive/15 text-destructive"
                    : "border-primary bg-primary/15 text-primary",
                ].join(" ")}
                onClick={() => {
                  confirmState.resolve(true);
                  setConfirmState(null);
                }}
              >
                {confirmState.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <InAppDialogsContext.Provider value={{ askPrompt, askConfirm }}>
      {children}
      {dialogs}
    </InAppDialogsContext.Provider>
  );
}
