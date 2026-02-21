export function isElectrobun() {
  return (
    typeof window !== "undefined" &&
    typeof (window as any).__electrobunWebviewId === "number"
  );
}

