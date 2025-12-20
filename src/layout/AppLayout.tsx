import { useEffect, useMemo, useRef, useState } from "react";
import { PanelBottom, PanelLeft, Settings, X } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { SettingsModal } from "../components/SettingsModal";
import { readJSON, writeJSON } from "../lib/localStorage";
import { applyTheme, getStoredTheme } from "../lib/theme";

import logoUrl from "../design/logo.svg";

type LayoutState = {
  showLeft: boolean;
  showRight: boolean;
  showBottom: boolean;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
};

const STORAGE_KEY = "context-assistant.layout.v1";

const DEFAULTS: LayoutState = {
  showLeft: true,
  showRight: true,
  showBottom: true,
  leftWidth: 280,
  rightWidth: 360,
  bottomHeight: 260,
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

export function AppLayout() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Apply persisted theme on initial mount.
  useEffect(() => applyTheme(getStoredTheme()), []);

  const [layout, setLayout] = useState<LayoutState>(() => {
    const raw = readJSON<Partial<LayoutState>>(STORAGE_KEY);
    return {
      ...DEFAULTS,
      ...raw,
    };
  });

  // Persist layout (debounced) whenever it changes.
  useEffect(() => {
    const t = window.setTimeout(() => writeJSON(STORAGE_KEY, layout), 150);
    return () => window.clearTimeout(t);
  }, [layout]);

  const mainRef = useRef<HTMLDivElement | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const [mainSize, setMainSize] = useState({ width: 0, height: 0 });
  const [centerSize, setCenterSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!mainRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setMainSize({ width: rect.width, height: rect.height });
    });
    ro.observe(mainRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!centerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setCenterSize({ width: rect.width, height: rect.height });
    });
    ro.observe(centerRef.current);
    return () => ro.disconnect();
  }, []);

  // Clamp sizes when container resizes.
  useEffect(() => {
    const minCenterWidth = 240;
    const minTopHeight = 120;

    const leftMin = 200;
    const leftMax = 500;

    const rightMin = 320;
    const rightMax =
      mainSize.width > 0
        ? Math.max(
            rightMin,
            mainSize.width - minCenterWidth - (layout.showLeft ? leftMin : 0),
          )
        : Number.POSITIVE_INFINITY;

    const bottomMin = 200;
    const bottomMax =
      centerSize.height > 0
        ? Math.max(bottomMin, centerSize.height - minTopHeight)
        : Number.POSITIVE_INFINITY;

    setLayout((prev) => ({
      ...prev,
      leftWidth: clamp(prev.leftWidth, leftMin, leftMax),
      // Avoid clamping these until we have real measurements; otherwise we
      // force them to the min on initial load and overwrite localStorage.
      rightWidth:
        mainSize.width > 0
          ? clamp(prev.rightWidth, rightMin, rightMax)
          : prev.rightWidth,
      bottomHeight:
        centerSize.height > 0
          ? clamp(prev.bottomHeight, bottomMin, bottomMax)
          : prev.bottomHeight,
    }));
  }, [mainSize.width, centerSize.height, layout.showLeft]);

  const constraints = useMemo(() => {
    const minCenterWidth = 240;
    const minTopHeight = 120;

    const leftMin = 200;
    const leftMax = 500;

    const rightMin = 320;
    const rightMax =
      mainSize.width > 0
        ? Math.max(
            rightMin,
            mainSize.width - minCenterWidth - (layout.showLeft ? leftMin : 0),
          )
        : Number.POSITIVE_INFINITY;

    const bottomMin = 200;
    const bottomMax =
      centerSize.height > 0
        ? Math.max(bottomMin, centerSize.height - minTopHeight)
        : Number.POSITIVE_INFINITY;

    return { leftMin, leftMax, rightMin, rightMax, bottomMin, bottomMax };
  }, [centerSize.height, layout.showLeft, mainSize.width]);

  const dragRef = useRef<
    | null
    | { kind: "left"; startX: number; startWidth: number }
    | { kind: "right"; startX: number; startWidth: number }
    | { kind: "bottom"; startY: number; startHeight: number }
  >(null);

  const onLeftHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind: "left",
      startX: e.clientX,
      startWidth: layout.leftWidth,
    };
  };

  const onRightHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind: "right",
      startX: e.clientX,
      startWidth: layout.rightWidth,
    };
  };

  const onBottomHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind: "bottom",
      startY: e.clientY,
      startHeight: layout.bottomHeight,
    };
  };

  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    setLayout((prev) => {
      if (drag.kind === "left") {
        const next = drag.startWidth + (e.clientX - drag.startX);
        return {
          ...prev,
          leftWidth: clamp(next, constraints.leftMin, constraints.leftMax),
        };
      }
      if (drag.kind === "right") {
        // Dragging handle to the right reduces the right panel.
        const next = drag.startWidth - (e.clientX - drag.startX);
        return {
          ...prev,
          rightWidth: clamp(next, constraints.rightMin, constraints.rightMax),
        };
      }
      // bottom
      const next = drag.startHeight - (e.clientY - drag.startY);
      return {
        ...prev,
        bottomHeight: clamp(next, constraints.bottomMin, constraints.bottomMax),
      };
    });
  };

  const onHandlePointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground">
      {/* Top nav (40px) */}
      <header className="h-10 shrink-0 border-b px-3 flex items-center">
        <div className="text-sm font-semibold">Context Assistant</div>
        <div className="flex-1" />

        <div className="flex items-center">
          <IconButton
            label={layout.showLeft ? "Hide left frame" : "Show left frame"}
            active={layout.showLeft}
            onClick={() =>
              setLayout((prev) => ({ ...prev, showLeft: !prev.showLeft }))
            }
          >
            <PanelLeft className="h-4 w-4" />
          </IconButton>

          <IconButton
            label={
              layout.showBottom ? "Hide bottom frame" : "Show bottom frame"
            }
            active={layout.showBottom}
            onClick={() =>
              setLayout((prev) => ({ ...prev, showBottom: !prev.showBottom }))
            }
          >
            <PanelBottom className="h-4 w-4" />
          </IconButton>

          <button
            type="button"
            aria-label={
              layout.showRight ? "Hide right frame" : "Show right frame"
            }
            title={layout.showRight ? "Hide right frame" : "Show right frame"}
            className={[
              "inline-flex h-8 w-8 items-center justify-center rounded-sm border-none",
              "bg-background hover:bg-muted",
              layout.showRight ? "" : "opacity-50",
            ].join(" ")}
            onClick={() =>
              setLayout((prev) => ({ ...prev, showRight: !prev.showRight }))
            }
          >
            <img src={logoUrl} alt="Toggle right frame" className="h-4 w-4" />
          </button>

          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
          </IconButton>
        </div>
      </header>

      {/* Main */}
      <div ref={mainRef} className="flex-1 min-h-0 flex">
        {/* Left */}
        {layout.showLeft && (
          <aside
            className="shrink-0 min-w-0 bg-muted/20"
            style={{ width: layout.leftWidth }}
          >
            <div className="h-full flex flex-col">
              <div className="h-10 shrink-0 bg-secondary px-2 flex items-center justify-between">
                <div className="text-sm font-medium">Left</div>
                <IconButton
                  label="Close left frame"
                  onClick={() =>
                    setLayout((prev) => ({ ...prev, showLeft: false }))
                  }
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="flex-1 min-h-0 p-3 text-sm text-muted-foreground">
                Left frame
              </div>
            </div>
          </aside>
        )}

        {/* Left resize handle */}
        {layout.showLeft && (
          <ResizeHandle
            orientation="vertical"
            onPointerDown={onLeftHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
          />
        )}

        {/* Center */}
        <section
          ref={centerRef}
          className="flex-1 min-w-0 min-h-0 flex flex-col"
        >
          {/* Top frame */}
          <div className="flex-1 min-h-0 p-4">Top frame (main content)</div>

          {/* Bottom resize handle */}
          {layout.showBottom && (
            <ResizeHandle
              orientation="horizontal"
              onPointerDown={onBottomHandlePointerDown}
              onPointerMove={onHandlePointerMove}
              onPointerUp={onHandlePointerUp}
            />
          )}

          {/* Bottom frame */}
          {layout.showBottom && (
            <div
              className="shrink-0 bg-muted/20"
              style={{ height: layout.bottomHeight }}
            >
              <div className="h-full flex flex-col">
                <div className="h-10 shrink-0 bg-secondary px-2 flex items-center justify-between">
                  <div className="text-sm font-medium">Bottom</div>
                  <IconButton
                    label="Close bottom frame"
                    onClick={() =>
                      setLayout((prev) => ({ ...prev, showBottom: false }))
                    }
                  >
                    <X className="h-4 w-4" />
                  </IconButton>
                </div>
                <div className="flex-1 min-h-0 p-3 text-sm text-muted-foreground">
                  Bottom frame
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Right resize handle */}
        {layout.showRight && (
          <ResizeHandle
            orientation="vertical"
            onPointerDown={onRightHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
          />
        )}

        {/* Right */}
        {layout.showRight && (
          <aside
            className="shrink-0 min-w-0 bg-muted/20"
            style={{ width: layout.rightWidth }}
          >
            <div className="h-full flex flex-col">
              <div className="h-10 shrink-0 bg-secondary px-2 flex items-center justify-between">
                <div className="text-sm font-medium">Right</div>
                <IconButton
                  label="Close right frame"
                  onClick={() =>
                    setLayout((prev) => ({ ...prev, showRight: false }))
                  }
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
              <div className="flex-1 min-h-0 p-3 text-sm text-muted-foreground">
                Right frame
              </div>
            </div>
          </aside>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function ResizeHandle({
  orientation,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  orientation: "vertical" | "horizontal";
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={[
        "shrink-0 hover:bg-border",
        "opacity-50",
        "touch-none select-none",
        orientation === "vertical"
          ? "w-2 cursor-col-resize separator-vertical"
          : "h-2 cursor-row-resize separator-horizontal",
      ].join(" ")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
