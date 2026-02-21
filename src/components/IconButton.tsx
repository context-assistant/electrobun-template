import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
  label: string;
};

export function IconButton({
  active,
  className,
  children,
  label,
  ...props
}: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[
        "inline-flex h-[12px] w-[12px] items-center justify-center rounded-sm border-none text-sm",
        "bg-background text-foreground hover:bg-muted",
        "cursor-pointer",
        active ? "opacity-50" : "opacity-20",
        className ?? "",
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}
