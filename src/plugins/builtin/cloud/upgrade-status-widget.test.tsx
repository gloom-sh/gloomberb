/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { CloudUpgradeStatusWidget } from "./upgrade-status-widget";
import { STATUS_WIDGET_COLUMNS, useClaimedStatusWidgetColumns, usePublishStatusWidgetRoom } from "../../../components/layout/status-widget-space";

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

test("a narrow bar shortens the label to upgrade rather than clip it into Feedback, and claims what it draws past its share", async () => {
  const spy = spyOn(apiClient, "getCurrentUser").mockReturnValue(null as never);
  restore = () => spy.mockRestore();
  let claimed = 0;
  function Bar({ room }: { room: number }) {
    usePublishStatusWidgetRoom(room);
    claimed = useClaimedStatusWidgetColumns();
    return <CloudUpgradeStatusWidget controller={controller} />;
  }
  const at = async (room: number) => {
    await tui.render(<Bar room={room} />);
    await tui.renderFrames(2);
    return tui.frame().trim();
  };
  // The mark and "upgrade" take 13 columns, 3 past half the held-back 20; "delayed data · " is 15 more.
  expect(await at(STATUS_WIDGET_COLUMNS + 18)).toBe("◷15m delayed data · upgrade");
  expect(claimed).toBe(18);
  expect(await at(STATUS_WIDGET_COLUMNS + 17)).toBe("◷15m upgrade");
  expect(claimed).toBe(3);
});
