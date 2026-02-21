import { useEffect, useMemo, useState } from "react";
import * as dockerClient from "../lib/docker";
import type { PreviewDescriptor } from "../lib/preview";

type Props = {
  containerId: string | null;
  path: string;
  descriptor: PreviewDescriptor;
};

type PreviewState = {
  loading: boolean;
  dataUrl: string | null;
  error: string | null;
};

export function PreviewPane({ containerId, path, descriptor }: Props) {
  const [state, setState] = useState<PreviewState>({
    loading: true,
    dataUrl: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!containerId) {
      setState({
        loading: false,
        dataUrl: null,
        error: "No running container selected for file preview.",
      });
      return;
    }
    setState({ loading: true, dataUrl: null, error: null });
    void (async () => {
      try {
        const contentBase64 = await dockerClient.readFileBase64(containerId, `/${path.replace(/^\/+/, "")}`);
        if (cancelled) return;
        setState({
          loading: false,
          dataUrl: `data:${descriptor.mimeType};base64,${contentBase64}`,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          loading: false,
          dataUrl: null,
          error: error instanceof Error ? error.message : "Failed to load preview.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [containerId, descriptor.mimeType, path]);

  const content = useMemo(() => {
    if (state.loading) return <div className="text-xs text-muted-foreground">Loading preview…</div>;
    if (state.error) return <div className="text-xs text-destructive">{state.error}</div>;
    if (!state.dataUrl) return <div className="text-xs text-muted-foreground">No preview available.</div>;

    if (descriptor.kind === "image") {
      return <img src={state.dataUrl} alt={path} className="max-h-full max-w-full object-contain" />;
    }
    if (descriptor.kind === "video") {
      return <video src={state.dataUrl} controls className="max-h-full max-w-full" />;
    }
    if (descriptor.kind === "audio") {
      return (
        <div className="w-full max-w-xl rounded border bg-background p-4">
          <div className="mb-2 text-xs text-muted-foreground">{path}</div>
          <audio src={state.dataUrl} controls className="w-full" />
        </div>
      );
    }
    if (descriptor.kind === "pdf") {
      return <iframe src={state.dataUrl} className="h-full w-full border-0" title={path} />;
    }
    return (
      <div className="rounded border bg-background p-3 text-xs text-muted-foreground">
        3D preview is not yet available for this format. File opened in Preview tab.
      </div>
    );
  }, [descriptor.kind, path, state.dataUrl, state.error, state.loading]);

  return <div className="h-full min-h-0 w-full overflow-auto p-3 flex items-center justify-center">{content}</div>;
}
