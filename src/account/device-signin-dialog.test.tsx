import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../api-client";
import { createOpenTuiTestHarness, TestDialogProvider } from "../renderers/opentui/test-utils";
import { blockExternalNetwork } from "../test-support/network-guard";
import { DeviceSignInDialogHost, requestDeviceSignInDialog } from "./device-signin-dialog";

blockExternalNetwork();
const tui = createOpenTuiTestHarness({ width: 90, height: 40 });
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const TITLE = "Sign in to Gloom";

async function open(code: "shown" | "requested"): Promise<void> {
  spies.push(spyOn(apiClient, "startDeviceSignIn").mockImplementation(() => code === "shown"
    ? Promise.resolve({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      verificationUri: "https://gloom.sh/link/ABCD-1234",
      pollIntervalMs: 600_000,
    } as never)
    // Gloom Cloud has not answered yet: no code is out.
    : new Promise<never>(() => {})));
  spies.push(spyOn(apiClient, "pollDeviceSignIn").mockResolvedValue({ status: "pending" } as never));
  await tui.render(<TestDialogProvider><DeviceSignInDialogHost /></TestDialogProvider>);
  await act(async () => { requestDeviceSignInDialog(); });
  await tui.waitForFrameToContain(code === "shown" ? "Waiting for approval" : "Contacting Gloom Cloud", 40);
}

async function clickAt(column: number, row: number): Promise<void> {
  await act(async () => {
    await tui.setup().mockMouse.click(column, row);
    await tui.setup().renderOnce();
  });
}

// The terminal's device sign-in closed only by Esc: a mouse could not leave it.
test("the device sign-in closes from its close button while a code waits for approval, and a stray click outside leaves it", async () => {
  await open("shown");
  await clickAt(0, 0);
  expect(tui.frame()).toContain("ABCD-1234");
  const rows = tui.frame().split("\n");
  const titleRow = rows.findIndex((line) => line.includes(TITLE));
  const closeColumn = rows[titleRow]!.lastIndexOf(" x ") + 1;
  expect(closeColumn).toBeGreaterThan(0);
  await clickAt(closeColumn, titleRow);
  await tui.waitForFrameToExclude(TITLE);
});

test("a click outside closes the device sign-in while no code is out", async () => {
  await open("requested");
  await clickAt(0, 0);
  await tui.waitForFrameToExclude(TITLE);
});
