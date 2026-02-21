import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";

const PRESET_HEX = [
  "#000000",
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#78716c",
  "#a8a29e",
];

function isValidHex(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim());
}

function normalizeHex(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith("#")) return `#${trimmed}`;
  return trimmed;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  if (v.length === 3) {
    return {
      r: parseInt(v[0] + v[0], 16),
      g: parseInt(v[1] + v[1], 16),
      b: parseInt(v[2] + v[2], 16),
    };
  }
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, v: v * 100 };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb.r, rgb.g, rgb.b) : null;
}

function hsvToHex(h: number, s: number, v: number): string {
  const rgb = hsvToRgb(h, s, v);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

const HUE_STOPS = [
  "rgb(255,0,0)",
  "rgb(255,255,0)",
  "rgb(0,255,0)",
  "rgb(0,255,255)",
  "rgb(0,0,255)",
  "rgb(255,0,255)",
  "rgb(255,0,0)",
];

type Props = {
  value: string;
  onChange: (hex: string) => void;
  onDoubleClick?: () => void;
  className?: string;
  disabled?: boolean;
};

/** In-app color picker for ElectroBun where native <input type="color"> does not render. */
export function InAppColorPicker({
  value,
  onChange,
  onDoubleClick,
  className = "",
  disabled = false,
}: Props) {
  const VIEWPORT_MARGIN = 8;
  const POPOVER_GAP = 6;
  const POPOVER_WIDTH = 224;
  const MIN_POPOVER_HEIGHT = 120;
  const ESTIMATED_POPOVER_HEIGHT = 260;
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [hsv, setHsv] = useState(() => hexToHsv(value) ?? { h: 0, s: 100, v: 100 });
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const svAreaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef<"sv" | "hue" | null>(null);
  const [panelPosition, setPanelPosition] = useState<null | { left: number; top: number; maxHeight: number }>(null);

  // Sync HSV when value changes externally (e.g. reset)
  useEffect(() => {
    const parsed = hexToHsv(value);
    if (parsed) setHsv(parsed);
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    if (open) {
      const parsed = hexToHsv(value);
      if (parsed) setHsv(parsed);
      setInputValue(value);
      inputRef.current?.focus();
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = containerRef.current?.contains(target);
      const inPanel = panelRef.current?.contains(target);
      if (!inTrigger && !inPanel) {
        setOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerUp = () => {
      isDraggingRef.current = null;
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEscape);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };
  }, [open]);

  const computePanelPosition = useCallback(
    (panelHeightEstimate: number) => {
      if (!containerRef.current || typeof window === "undefined") return null;
      const triggerRect = containerRef.current.getBoundingClientRect();
      const minLeft = VIEWPORT_MARGIN;
      const maxLeft = Math.max(minLeft, window.innerWidth - VIEWPORT_MARGIN - POPOVER_WIDTH);
      const left = Math.min(Math.max(triggerRect.left, minLeft), maxLeft);

      const availableBelow = Math.max(0, window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN - POPOVER_GAP);
      const availableAbove = Math.max(0, triggerRect.top - VIEWPORT_MARGIN - POPOVER_GAP);
      const shouldOpenUp =
        availableBelow < panelHeightEstimate && availableAbove > availableBelow;
      const availableSpace = shouldOpenUp ? availableAbove : availableBelow;
      const maxHeight = Math.max(MIN_POPOVER_HEIGHT, availableSpace);
      const resolvedHeight = Math.min(panelHeightEstimate, maxHeight);
      const top = shouldOpenUp
        ? triggerRect.top - resolvedHeight - POPOVER_GAP
        : triggerRect.bottom + POPOVER_GAP;
      const clampedTop = Math.min(
        Math.max(top, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - resolvedHeight)
      );
      return { left, top: clampedTop, maxHeight };
    },
    [MIN_POPOVER_HEIGHT, POPOVER_GAP, POPOVER_WIDTH, VIEWPORT_MARGIN]
  );

  useEffect(() => {
    if (!open) {
      setPanelPosition(null);
      return;
    }
    const recalc = () => {
      const measuredHeight = panelRef.current?.getBoundingClientRect().height ?? ESTIMATED_POPOVER_HEIGHT;
      setPanelPosition(computePanelPosition(measuredHeight));
    };
    recalc();
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [computePanelPosition, ESTIMATED_POPOVER_HEIGHT, open]);

  const updateFromHsv = useCallback(
    (next: { h: number; s: number; v: number }) => {
      setHsv(next);
      const hex = hsvToHex(next.h, next.s, next.v);
      setInputValue(hex);
      onChange(hex);
    },
    [onChange],
  );

  const handleSvPointer = useCallback(
    (e: PointerEvent) => {
      const el = svAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const s = x * 100;
      const v = (1 - y) * 100;
      updateFromHsv({ ...hsv, s, v });
    },
    [hsv, updateFromHsv],
  );

  const handleHuePointer = useCallback(
    (e: PointerEvent) => {
      const el = hueRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const h = x * 360;
      updateFromHsv({ ...hsv, h });
    },
    [hsv, updateFromHsv],
  );

  const applyValue = useCallback(
    (raw: string) => {
      const normalized = normalizeHex(raw);
      if (isValidHex(normalized)) {
        const expanded =
          normalized.length === 4
            ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
            : normalized;
        onChange(expanded);
        const parsed = hexToHsv(expanded);
        if (parsed) setHsv(parsed);
        setInputValue(expanded);
        setOpen(false);
      }
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyValue(inputValue);
      }
    },
    [inputValue, applyValue],
  );

  const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        className={`h-5 w-10 shrink-0 cursor-pointer rounded border border-border bg-background p-0.5 ${className}`}
        style={{ backgroundColor: isValidHex(value) ? value : "#000" }}
        onClick={() => !disabled && setOpen((o) => !o)}
        onDoubleClick={onDoubleClick}
        title="Click to edit color, double-click to reset"
      />
      {open &&
        panelPosition &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          ref={panelRef}
          className="fixed z-[10000] w-56 overflow-y-auto rounded-md border border-border bg-background p-3 shadow-lg"
          style={{ left: panelPosition.left, top: panelPosition.top, maxHeight: panelPosition.maxHeight }}
        >
          {/* Saturation/Value 2D picker */}
          <div
            ref={svAreaRef}
            className="relative h-28 w-full cursor-crosshair touch-none rounded border border-border"
            style={{
              background: `linear-gradient(to bottom, transparent, black),
                linear-gradient(to right, white, hsl(${hsv.h}, 100%, 50%))`,
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              svAreaRef.current?.setPointerCapture(e.pointerId);
              isDraggingRef.current = "sv";
              handleSvPointer(e);
            }}
            onPointerMove={(e) => {
              if (isDraggingRef.current === "sv") handleSvPointer(e);
            }}
          >
            <div
              className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
              style={{
                left: `${hsv.s}%`,
                top: `${100 - hsv.v}%`,
                backgroundColor: currentHex,
              }}
            />
          </div>

          {/* Hue slider */}
          <div
            ref={hueRef}
            className="relative mt-2 h-3 w-full cursor-pointer touch-none rounded border border-border"
            style={{
              background: `linear-gradient(to right, ${HUE_STOPS.join(", ")})`,
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              hueRef.current?.setPointerCapture(e.pointerId);
              isDraggingRef.current = "hue";
              handleHuePointer(e);
            }}
            onPointerMove={(e) => {
              if (isDraggingRef.current === "hue") handleHuePointer(e);
            }}
          >
            <div
              className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
              style={{
                left: `${(hsv.h / 360) * 100}%`,
                backgroundColor: currentHex,
              }}
            />
          </div>

          {/* Hex input */}
          <div className="mt-3 flex items-center gap-2">
            <div
              className="h-5 w-10 shrink-0 rounded border border-border"
              style={{ backgroundColor: currentHex }}
            />
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="#000000"
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            />
          </div>

          {/* Preset swatches */}
          <div className="mt-3 grid grid-cols-6 gap-1">
            {PRESET_HEX.map((hex) => (
              <button
                key={hex}
                type="button"
                className="h-5 w-5 rounded border border-border hover:ring-1 hover:ring-primary"
                style={{ backgroundColor: hex }}
                onClick={() => applyValue(hex)}
                title={hex}
              />
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
