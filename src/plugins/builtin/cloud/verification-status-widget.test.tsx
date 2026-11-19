/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import * as authDialog from "../../../account/auth-dialog";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { CloudVerificationStatusWidget } from "./verification-status-widget";

const tui = createOpenTuiTestHarness({ width: 60, height: 3 });
const UNVERIFIED = { id: "u1", email: "ana@example.com", emailVerified: false, plan: "free" };
const restore: Array<() => void> = [];

afterEach(() => { restore.splice(0).forEach((reset) => reset()); });

function signIn(user: unknown) {
  const current = spyOn(apiClient, "getCurrentUser").mockReturnValue(user as never);
  const session = spyOn(apiClient, "getSession").mockResolvedValue(user as never);
  const send = spyOn(apiClient, "sendVerification").mockResolvedValue(undefined as never);
  restore.push(() => current.mockRestore(), () => session.mockRestore(), () => send.mockRestore());
  return send;
}

async function pressChip() {
  const row = tui.frame().split("\n").findIndex((line) => line.includes("verify your email"));
  const col = tui.frame().split("\n")[row]!.indexOf("verify your email") + 2;
  await act(async () => {
    await tui.setup().mockMouse.click(col, row);
    await tui.setup().renderOnce();
  });
}

// The chip used to send the link itself, with a toast as the only sign of where it went.
test("a press on verify your email opens the confirmation dialog, and still sends the link where none can open", async () => {
  const send = signIn(UNVERIFIED);
  const confirm = spyOn(authDialog, "requestEmailConfirmation").mockReturnValue(true);
  restore.push(() => confirm.mockRestore());
  await tui.render(<CloudVerificationStatusWidget />);
  await tui.waitForFrameToContain("verify your email");
  await pressChip();
  expect(confirm).toHaveBeenCalledTimes(1);
  // The dialog sends it; the chip does not send a second one.
  expect(send).not.toHaveBeenCalled();

  confirm.mockReturnValue(false);
  await pressChip();
  expect(send).toHaveBeenCalledTimes(1);
});

test("a confirmed account has no chip", async () => {
  signIn({ ...UNVERIFIED, emailVerified: true });
  await tui.render(<CloudVerificationStatusWidget />);
  await tui.renderFrames(1);
  expect(tui.frame().trim()).toBe("");
});
