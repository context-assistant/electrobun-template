import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Moon, Sun, SunMoon, X } from "lucide-react";
import { IconButton } from "./IconButton";
import {
  applyTheme,
  getStoredTheme,
  setStoredTheme,
  type ThemeMode,
} from "../lib/theme";

type Props = {
  open: boolean;
  onClose: () => void;
};

type SettingsGroup = "general";

export function SettingsModal({ open, onClose }: Props) {
  const [group, setGroup] = useState<SettingsGroup>("general");
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    setStoredTheme(theme);
    return applyTheme(theme);
  }, [theme]);

  const body = useMemo(() => {
    if (!open) return null;

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="w-full max-w-3xl overflow-hidden rounded-xl border bg-background text-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="font-semibold">Settings</div>
            <IconButton label="Close settings" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="grid grid-cols-[220px_1fr] min-h-[360px]">
            <nav className="border-r bg-muted/30 p-2">
              <button
                type="button"
                className={[
                  "w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                  group === "general" ? "bg-muted font-medium" : "",
                ].join(" ")}
                onClick={() => setGroup("general")}
              >
                General
              </button>
            </nav>

            <div className="p-4">
              {group === "general" && (
                <div className="max-w-xl">
                  <div className="text-sm font-semibold mb-4">General</div>

                  <div className="rounded-lg border p-4">
                    <div className="text-sm font-medium mb-2">Theme</div>
                    <div className="text-sm text-muted-foreground mb-4">
                      Choose light/dark, or follow your system setting
                      (default).
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <ThemeOption
                        mode="system"
                        current={theme}
                        icon={<SunMoon className="h-4 w-4" />}
                        title="System"
                        description="Default"
                        onSelect={setTheme}
                      />
                      <ThemeOption
                        mode="light"
                        current={theme}
                        icon={<Sun className="h-4 w-4" />}
                        title="Light"
                        description="Always light"
                        onSelect={setTheme}
                      />
                      <ThemeOption
                        mode="dark"
                        current={theme}
                        icon={<Moon className="h-4 w-4" />}
                        title="Dark"
                        description="Always dark"
                        onSelect={setTheme}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }, [group, onClose, open, theme]);

  if (!open) return null;
  return createPortal(body, document.body);
}

function ThemeOption({
  mode,
  current,
  title,
  description,
  icon,
  onSelect,
}: {
  mode: ThemeMode;
  current: ThemeMode;
  title: string;
  description: string;
  icon: React.ReactNode;
  onSelect: (mode: ThemeMode) => void;
}) {
  const selected = mode === current;
  return (
    <button
      type="button"
      className={[
        "flex items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted",
        selected ? "ring-2 ring-ring" : "",
      ].join(" ")}
      onClick={() => onSelect(mode)}
    >
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </button>
  );
}
