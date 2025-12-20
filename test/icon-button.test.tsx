import "./dom";

import { afterEach, describe, expect, test } from "bun:test";

const { cleanup, render } = await import("@testing-library/react");
import { IconButton } from "../src/components/IconButton";

afterEach(() => {
  cleanup();
});

describe("IconButton", () => {
  test("renders an accessible button with the provided label", () => {
    const { getByRole } = render(
      <IconButton label="Open settings">
        <span>icon</span>
      </IconButton>,
    );

    const btn = getByRole("button", { name: "Open settings" });
    expect(btn.getAttribute("aria-label")).toBe("Open settings");
    expect(btn.getAttribute("title")).toBe("Open settings");
  });

  test("respects the active prop by changing opacity class", () => {
    const { getByRole, rerender } = render(
      <IconButton label="Example" active>
        <span />
      </IconButton>,
    );
    expect(getByRole("button", { name: "Example" }).className).not.toContain(
      "opacity-50",
    );

    rerender(
      <IconButton label="Example" active={false}>
        <span />
      </IconButton>,
    );
    expect(getByRole("button", { name: "Example" }).className).toContain(
      "opacity-50",
    );
  });
});


