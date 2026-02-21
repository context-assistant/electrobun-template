import { MoreVertical, X } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { IconButton } from "./IconButton";

export type FrameTab<T extends string> = {
  id: T;
  label: string;
  meta?: string;
  temporary?: boolean;
  dirty?: boolean;
  closable?: boolean;
  variant?: "default" | "agent";
  disabled?: boolean;
};

type Props<T extends string> = {
  tabs: FrameTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  onTabDoubleClick?: (tab: T) => void;
  onTabClose?: (tab: T) => void;
  renderTabLabel?: (tab: FrameTab<T>) => ReactNode;
  onClose?: () => void;
  actions?: ReactNode;
  className?: string;
  getTabProps?: (tab: FrameTab<T>, index: number) => TabBehaviorProps;
  tabsContainerProps?: TabsContainerBehaviorProps;
  tabsTrailingDropProps?: TabsContainerBehaviorProps;
};

type TabBehaviorProps = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "draggable"
  | "onDragStart"
  | "onDragEnd"
  | "onDragOver"
  | "onDrop"
  | "onDragEnter"
  | "onDragLeave"
> & {
  className?: string;
};

type TabsContainerBehaviorProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  "onDragOver" | "onDrop" | "onDragEnter" | "onDragLeave"
> & {
  className?: string;
};

export function FrameTabBar<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  onTabDoubleClick,
  onTabClose,
  renderTabLabel,
  onClose,
  actions,
  className,
  getTabProps,
  tabsContainerProps,
  tabsTrailingDropProps,
}: Props<T>) {
  return (
    <div
      className={[
        "h-6 shrink-0 border-b bg-secondary/40",
        "flex items-center justify-between gap-2",
        "pr-2",
        className ?? "",
      ].join(" ")}
    >
      <div
        className={[
          "min-w-0 flex flex-1 items-center overflow-auto",
          tabsContainerProps?.className ?? "",
        ].join(" ")}
        onDragOver={tabsContainerProps?.onDragOver}
        onDrop={tabsContainerProps?.onDrop}
        onDragEnter={tabsContainerProps?.onDragEnter}
        onDragLeave={tabsContainerProps?.onDragLeave}
      >
        {tabs.map((tab, index) => {
          const tabProps = getTabProps?.(tab, index);
          return (
            <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            aria-disabled={tab.disabled}
            disabled={tab.disabled}
            className={[
              "h-6 max-w-56 px-4 py-1 text-xs px-2 border-none",
              tab.disabled
                ? "opacity-30 cursor-not-allowed"
                : "",
                // : "border font-medium shadow-[inset_0_0_35px_0_rgba(0,0,0,0.5)]",
              tab.variant === "agent"
                ? tab.id === activeTab && !tab.disabled
                  ? "bg-sky-400/12 text-sky-800 dark:text-sky-200 font-medium"
                  : "bg-sky-400/6 text-sky-800/90 dark:text-sky-300"
                : tab.id === activeTab && !tab.disabled
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground",
              tabProps?.className ?? "",
            ].join(" ")}
            onClick={() => { if (!tab.disabled) onTabChange(tab.id); }}
            onDoubleClick={() => { if (!tab.disabled) onTabDoubleClick?.(tab.id); }}
            draggable={tabProps?.draggable}
            onDragStart={tabProps?.onDragStart}
            onDragEnd={tabProps?.onDragEnd}
            onDragOver={tabProps?.onDragOver}
            onDrop={tabProps?.onDrop}
            onDragEnter={tabProps?.onDragEnter}
            onDragLeave={tabProps?.onDragLeave}
          >
            <span className="inline-flex max-w-full items-center gap-1">
              {tab.dirty ? (
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
                  aria-label="Unsaved changes"
                />
              ) : null}
              <span
                className={[
                  "truncate",
                  tab.temporary ? "italic opacity-60" : "",
                ].join(" ")}
              >
                {renderTabLabel ? renderTabLabel(tab) : tab.label}
              </span>
              {tab.meta ? (
                <span className="rounded border px-1 text-[10px] text-muted-foreground">
                  {tab.meta}
                </span>
              ) : null}
              {onTabClose && tab.closable ? (
                <span
                  role="button"
                  aria-label={`Close ${tab.label}`}
                  className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted-foreground/15 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <X className="h-3 w-3" />
                </span>
              ) : null}
            </span>
          </button>
          );
        })}
        <div
          className={[
            "h-10 flex-1",
            tabsTrailingDropProps?.className ?? "",
          ].join(" ")}
          onDragOver={tabsTrailingDropProps?.onDragOver}
          onDrop={tabsTrailingDropProps?.onDrop}
          onDragEnter={tabsTrailingDropProps?.onDragEnter}
          onDragLeave={tabsTrailingDropProps?.onDragLeave}
        />
      </div>

      <div className="shrink-0 flex items-center gap-1">
        {actions}
        {onClose ? (
          <IconButton label="Close frame" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}

type FrameMenuItem = {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  keepOpen?: boolean;
};

type FrameMenuProps = {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  label: string;
  items: FrameMenuItem[];
  content?: ReactNode;
};

export function FrameKebabMenu({
  open,
  onToggle,
  onClose,
  label,
  items,
  content,
}: FrameMenuProps) {
  return (
    <div className="relative">
      <IconButton label={label} onClick={onToggle}>
        <MoreVertical className="h-4 w-4" />
      </IconButton>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-20 cursor-default"
            aria-label="Close menu"
            onClick={onClose}
          />
          <div className="absolute right-0 top-9 z-30 min-w-44 rounded-md border bg-background p-1 shadow-lg">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={item.disabled}
                className={[
                  "w-full px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50",
                  item.danger ? "text-destructive" : "",
                  item.dividerBefore ? "mt-1 border-t pt-2" : "",
                ].join(" ")}
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  if (!item.keepOpen) onClose();
                }}
              >
                {item.label}
              </button>
            ))}
            {content ? (
              <div className={items.length > 0 ? "mt-1 border-t p-2" : "p-2"}>
                {content}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
