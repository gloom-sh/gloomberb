/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { CloudUpgradeStatusWidget } from "./upgrade-status-widget";
import { STATUS_WIDGET_COLUMNS, useClaimedStatusWidgetColumns, usePublishStatusWidgetRoom } from "../../../components/layout/status-widget-space";
import { useDelayedMarkMinutes } from "../../../components/ui/delayed-mark";
import { Text } from "../../../ui";

const tui = createOpenTuiTestHarness({ width: 80, height: 3 });
const controller = { getSnapshot: () => ({}) as never, subscribe: () => () => {} };
const DAY_MS = 86_400_000;
const FREE = { id: "free", emailVerified: true, plan: "free" };
const PRO = { id: "pro", emailVerified: true, plan: "pro", effectivePlan: "pro" };
let restore = () => {};

afterEach(() => restore());

function signIn(user: unknown): void {
  const spy = spyOn(apiClient, "getCurrentUser").mockReturnValue(user as never);
  restore = () => spy.mockRestore();
}

async function statusFor(user: unknown): Promise<string> {
  signIn(user);
  await tui.render(<CloudUpgradeStatusWidget controller={controller} />);
  await tui.renderFrames(1);
  return tui.frame().trim();
}

/** A delayed quote's price outside a pane footer, as the header draws SPY: the mark it carries, if any. */
function PriceOutsideFooter() {
  const minutes = useDelayedMarkMinutes({ dataSource: "delayed" });
  return <Text>{`mark:${minutes ?? "none"}`}</Text>;
}

test("the status bar says once that prices are delayed signed out and on Free, counts a trial down, and says nothing on Pro", async () => {
  // Signed out was the gap before: the widget drew nothing while every price was delayed.
  for (const user of [null, FREE]) {
    const status = await statusFor(user);
    expect(status).toBe("◷15m delayed");
    // The note itself is the way to Pro; no separate upgrade chip beside it.
    expect(status).not.toContain("upgrade");
  }
  const trialEndsAt = new Date(Date.now() + 5 * DAY_MS).toISOString();
  const trial = await statusFor({ ...PRO, id: "trial", trialEndsAt });
  expect(trial).toContain("Pro trial");
  expect(trial).not.toContain("◷");
  expect(await statusFor(PRO)).toBe("");
});

test("a price outside a pane footer leaves its mark to the note while the note shows, and carries it otherwise", async () => {
  const markWith = async (user: unknown, withNote: boolean) => {
    signIn(user);
    await tui.render(<>{withNote ? <CloudUpgradeStatusWidget controller={controller} /> : null}<PriceOutsideFooter /></>);
    await tui.renderFrames(2);
    return /mark:(\w+)/.exec(tui.frame())?.[1];
  };
  // Signed out and Free: said once, by the status bar's note.
  expect(await markWith(null, true)).toBe("none");
  expect(await markWith(FREE, true)).toBe("none");
  // With no status bar (presentation mode, a capture of a pane alone) the price says it itself.
  expect(await markWith(null, false)).toBe("15");
  expect(await markWith(FREE, false)).toBe("15");
  // Pro sees the price live: neither marks it.
  expect(await markWith(PRO, true)).toBe("none");
  expect(await markWith(PRO, false)).toBe("none");
});

test("a narrow bar drops the word rather than clip the note into Feedback, and claims what it draws past its share", async () => {
  signIn(null);
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
  // The note and its space take 13 columns, 3 past half the held-back 20.
  expect(await at(STATUS_WIDGET_COLUMNS + 3)).toBe("◷15m delayed");
  expect(claimed).toBe(3);
  expect(await at(STATUS_WIDGET_COLUMNS + 2)).toBe("◷15m");
  expect(claimed).toBe(0);
});
