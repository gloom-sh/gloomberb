/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { CloudUpgradeStatusWidget } from "./upgrade-status-widget";

const tui = createOpenTuiTestHarness({ width: 80, height: 3 });
const controller = { getSnapshot: () => ({}) as never, subscribe: () => () => {} };
const DAY_MS = 86_400_000;
let restore = () => {};

afterEach(() => restore());

async function statusFor(user: unknown): Promise<string> {
  const spy = spyOn(apiClient, "getCurrentUser").mockReturnValue(user as never);
  restore = () => spy.mockRestore();
  await tui.render(<CloudUpgradeStatusWidget controller={controller} />);
  await tui.renderFrames(1);
  return tui.frame().trim();
}

test("the status bar says prices are delayed signed out and on Free, counts a trial down, and says nothing on Pro", async () => {
  // Signed out was the gap: the widget drew nothing while every price was delayed.
  expect(await statusFor(null)).toContain("◷15m delayed data · upgrade");
  expect(await statusFor({ id: "free", emailVerified: true, plan: "free" })).toContain("◷15m delayed data · upgrade");
  const trialEndsAt = new Date(Date.now() + 5 * DAY_MS).toISOString();
  const trial = await statusFor({ id: "trial", emailVerified: true, plan: "pro", effectivePlan: "pro", trialEndsAt });
  expect(trial).toContain("Pro trial");
  expect(trial).not.toContain("◷");
  expect(await statusFor({ id: "pro", emailVerified: true, plan: "pro", effectivePlan: "pro" })).toBe("");
});
