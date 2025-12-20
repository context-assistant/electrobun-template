import "./dom";

import { afterEach, describe, expect, test } from "bun:test";

const { cleanup, render } = await import("@testing-library/react");
const { within } = await import("@testing-library/dom");
const userEvent = (await import("@testing-library/user-event")).default;
import { SettingsModal } from "../src/components/SettingsModal";

afterEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore
  }
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("SettingsModal", () => {
  test("does not render when closed", () => {
    render(<SettingsModal open={false} onClose={() => {}} />);
    expect(within(document.body).queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  test("renders when open and closes via button click and Escape key", async () => {
    const user = userEvent.setup();
    let closes = 0;
    const onClose = () => {
      closes += 1;
    };

    render(<SettingsModal open onClose={onClose} />);

    // Portal should still be queryable from the document.
    expect(within(document.body).getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(within(document.body).getByText("Settings")).toBeTruthy();

    await user.click(
      within(document.body).getByRole("button", { name: "Close settings" }),
    );
    expect(closes).toBe(1);

    await user.keyboard("{Escape}");
    expect(closes).toBe(2);
  });

  test("changing theme updates the root dark class (light/dark)", async () => {
    const user = userEvent.setup();
    render(<SettingsModal open onClose={() => {}} />);

    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(
      within(document.body).getByRole("button", { name: /^Dark\b/i }),
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(
      within(document.body).getByRole("button", { name: /^Light\b/i }),
    );
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});


