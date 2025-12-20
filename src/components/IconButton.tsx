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
        "inline-flex h-8 w-8 items-center justify-center rounded-sm border-none text-sm",
        "bg-background hover:bg-muted",
        active ? "" : "opacity-50",
        className ?? "",
      ].join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}
