/**
 * Custom dropdown select that works in GTK WebKit on Linux.
 * Native <select> popups often fail in the Electrobun Linux webview (dropdown
 * doesn't appear, only logs). This component uses divs/buttons instead.
 * Uses a portal so the dropdown escapes overflow containers and stays on top.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Option = { value: string; label: string; group?: string };

export function CustomSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  className = "",
  onDoubleClick,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onDoubleClick?: () => void;
}) {
  const VIEWPORT_MARGIN = 8;
  const DROPDOWN_GAP = 4;
  const MIN_DROPDOWN_HEIGHT = 96;
  const ESTIMATED_DROPDOWN_HEIGHT = 240;
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  const selectedLabel =
    options.find((o) => o.value === value)?.label ?? placeholder ?? (value ? String(value) : "Select…");

  const optionsWithGroups = useMemo(() => {
    const seen = new Set<string>();
    return options.filter((opt) => {
      if (seen.has(opt.value)) return false;
      seen.add(opt.value);
      return true;
    });
  }, [options]);

  const selectedIndex = useMemo(
    () => optionsWithGroups.findIndex((o) => o.value === value),
    [optionsWithGroups, value]
  );

  const openMenu = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    setHighlightedIndex(idx);
  }, [disabled, selectedIndex]);

  const closeMenu = useCallback(() => setOpen(false), []);

  const computeDropdownRect = useCallback(
    (menuHeightEstimate: number) => {
      const el = containerRef.current;
      if (!el || typeof window === "undefined") return null;
      const rect = el.getBoundingClientRect();
      const maxAllowedWidth = Math.max(120, window.innerWidth - VIEWPORT_MARGIN * 2);
      const width = Math.max(120, Math.min(rect.width, maxAllowedWidth));
      const minLeft = VIEWPORT_MARGIN;
      const maxLeft = Math.max(minLeft, window.innerWidth - VIEWPORT_MARGIN - width);
      const left = Math.min(Math.max(rect.left, minLeft), maxLeft);

      const availableBelow = Math.max(0, window.innerHeight - rect.bottom - VIEWPORT_MARGIN - DROPDOWN_GAP);
      const availableAbove = Math.max(0, rect.top - VIEWPORT_MARGIN - DROPDOWN_GAP);
      const shouldOpenUp =
        availableBelow < Math.min(160, menuHeightEstimate) && availableAbove > availableBelow;
      const availableSpace = shouldOpenUp ? availableAbove : availableBelow;
      const maxHeight = Math.max(
        MIN_DROPDOWN_HEIGHT,
        Math.min(ESTIMATED_DROPDOWN_HEIGHT, availableSpace || ESTIMATED_DROPDOWN_HEIGHT)
      );
      const top = shouldOpenUp
        ? Math.max(
            VIEWPORT_MARGIN,
            rect.top - Math.min(menuHeightEstimate, maxHeight) - DROPDOWN_GAP
          )
        : Math.max(
            VIEWPORT_MARGIN,
            Math.min(rect.bottom + DROPDOWN_GAP, window.innerHeight - VIEWPORT_MARGIN - MIN_DROPDOWN_HEIGHT)
          );

      return { top, left, width, maxHeight };
    },
    [DROPDOWN_GAP, ESTIMATED_DROPDOWN_HEIGHT, MIN_DROPDOWN_HEIGHT, VIEWPORT_MARGIN]
  );

  // Sync highlighted index and measure position when menu opens (click or keyboard)
  useEffect(() => {
    if (open) {
      const idx = selectedIndex >= 0 ? selectedIndex : 0;
      setHighlightedIndex(idx);
      setDropdownRect(computeDropdownRect(ESTIMATED_DROPDOWN_HEIGHT));
    } else {
      setDropdownRect(null);
      optionRefs.current.clear();
    }
  }, [computeDropdownRect, ESTIMATED_DROPDOWN_HEIGHT, open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const recalc = () => {
      const measuredHeight = listboxRef.current?.getBoundingClientRect().height ?? ESTIMATED_DROPDOWN_HEIGHT;
      setDropdownRect(computeDropdownRect(measuredHeight));
    };
    recalc();
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [computeDropdownRect, ESTIMATED_DROPDOWN_HEIGHT, open]);

  // Scroll selected option into view when menu opens
  useEffect(() => {
    if (!open || optionsWithGroups.length === 0) return;
    const idx = selectedIndex >= 0 ? selectedIndex : 0;
    const el = optionRefs.current.get(idx);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [open, selectedIndex, optionsWithGroups.length]);

  // Outside click closes menu (dropdown is in portal, so check both trigger and listbox)
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = containerRef.current?.contains(target);
      const inDropdown = listboxRef.current?.contains(target);
      if (!inTrigger && !inDropdown) {
        closeMenu();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, closeMenu]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      const n = optionsWithGroups.length;
      if (n === 0) return;

      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMenu();
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((i) => Math.min(i + 1, n - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          {
            const opt = optionsWithGroups[highlightedIndex];
            if (opt) {
              onChange(opt.value);
              closeMenu();
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          break;
        case "Home":
          e.preventDefault();
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setHighlightedIndex(n - 1);
          break;
      }
    },
    [disabled, open, optionsWithGroups, highlightedIndex, onChange, openMenu, closeMenu]
  );

  // Scroll highlighted option into view when it changes via keyboard
  useEffect(() => {
    if (!open) return;
    const el = optionRefs.current.get(highlightedIndex);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlightedIndex]);

  return (
    <div ref={containerRef} className="relative flex-1">
      <button
        type="button"
        disabled={disabled}
        className={`w-full rounded-md border bg-background px-2 py-2 text-left text-sm text-foreground ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${className}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        onDoubleClick={onDoubleClick}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open ? `option-${highlightedIndex}` : undefined}
      >
        <span className="block truncate">{selectedLabel}</span>
      </button>
      {open &&
        dropdownRect &&
        createPortal(
          <ul
            ref={listboxRef}
            role="listbox"
            id="custom-select-listbox"
            className="fixed z-[9999] max-h-60 min-w-45 overflow-auto rounded-md border bg-background py-1 shadow-lg"
            style={{
              top: dropdownRect.top,
              left: dropdownRect.left,
              width: dropdownRect.width,
              maxHeight: dropdownRect.maxHeight,
            }}
          >
            {optionsWithGroups.map((opt, idx) => {
              const group = opt.group ?? "";
              const prevGroup = idx > 0 ? (optionsWithGroups[idx - 1]?.group ?? "") : "";
              const showGroupHeader = group && group !== prevGroup;
              const isHighlighted = idx === highlightedIndex;
              const isSelected = opt.value === value;
              return (
                <React.Fragment key={opt.value}>
                  {showGroupHeader && (
                    <li className="px-2 py-1.5 text-xs font-medium text-muted-foreground list-none">
                      {group}
                    </li>
                  )}
                  <li
                    ref={(el) => {
                      if (el) optionRefs.current.set(idx, el);
                    }}
                    id={`option-${idx}`}
                    role="option"
                    aria-selected={isSelected}
                    className={`cursor-pointer px-2 py-2 text-sm ${group ? "pl-4" : ""} ${isHighlighted ? "bg-muted font-medium" : isSelected ? "bg-muted/70 font-medium" : "hover:bg-muted/60"}`}
                    onClick={() => {
                      onChange(opt.value);
                      closeMenu();
                    }}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                  >
                    {opt.label}
                  </li>
                </React.Fragment>
              );
            })}
          </ul>,
          document.body
        )}
    </div>
  );
}
