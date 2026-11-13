import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { blockExternalNetwork } from "../test-support/network-guard";
import { AuthDialogHost, isAuthDialogOpen, requestAuthDialog } from "./auth-dialog";

blockExternalNetwork();
const tui = createOpenTuiTestHarness();

async function openSignUp(): Promise<string> {
  await tui.render(<AuthDialogHost />, { width: 100, height: 40 });
  await act(async () => {
    expect(requestAuthDialog({ mode: "signup", reason: "Stock quotes are 15 min delayed without Pro." })).toBe(true);
  });
  return tui.waitForFrameToContain("Create your free Gloom Cloud account");
}

// A mouse alone must close the sign-up dialog the delayed mark opens: it had no close button and ignored a click
// outside, so only Esc closed it.
describe("sign-up dialog", () => {
  test("closes from its close button, and says what is delayed", async () => {
    const frame = await openSignUp();
    expect(frame).toContain("Stock quotes are 15 min delayed without Pro.");
    const rows = frame.split("\n");
    const titleRow = rows.findIndex((line) => line.includes("Create your free Gloom Cloud account"));
    const closeCol = rows[titleRow]!.lastIndexOf(" x ") + 1;
    expect(closeCol).toBeGreaterThan(0);
    await act(async () => {
      await tui.setup().mockMouse.click(closeCol, titleRow);
    });
    await tui.waitForFrameToExclude("Create your free Gloom Cloud account");
    expect(isAuthDialogOpen()).toBe(false);
  });

  test("closes on a click outside it", async () => {
    await openSignUp();
    await act(async () => {
      await tui.setup().mockMouse.click(1, 1);
    });
    await tui.waitForFrameToExclude("Create your free Gloom Cloud account");
    expect(isAuthDialogOpen()).toBe(false);
  });
});
