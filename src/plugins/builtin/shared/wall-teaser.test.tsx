import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import * as activity from "../../../api-client/research-activity";
import * as wallSummary from "../../../api-client/wall-summary";
import { Button, PaneStatusBody } from "../../../components";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { WallTeaser } from "./wall-teaser";

const tui = createOpenTuiTestHarness({ width: 84, height: 20 });
const restore: Array<() => void> = [];
let upgrades = 0;

beforeEach(() => {
  upgrades = 0;
  const user = spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "wall-render", plan: "free", emailVerified: true } as AuthUser);
  const viewed = spyOn(activity, "recordWallViewed").mockImplementation(() => {});
  restore.push(() => user.mockRestore(), () => viewed.mockRestore());
});
afterEach(() => { restore.splice(0).forEach((reset) => reset()); });

function arm(value: "control" | "teaser" | null | Promise<"control" | "teaser" | null>) {
  const mock = spyOn(activity, "exposeWallTeaser").mockImplementation(async () => value);
  restore.push(() => mock.mockRestore());
}

const title = "Risk factors are part of Gloom Cloud Pro.";
const message = "What was added, dropped or rewritten since the year before.";
function OriginalWall() {
  return <PaneStatusBody empty emptyTitle={title} emptyMessage={message} actions={<>
    <Button label="Upgrade to Pro" onPress={() => { upgrades++; }} />
    <Button label="Manage account" variant="secondary" onPress={() => {}} />
  </>} />;
}

function Harness({ original = false, symbol = "AAPL", width = 84, height = 20, placement = "risk-wall" }: {
  original?: boolean; symbol?: string; width?: number; height?: number; placement?: string;
}) {
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-wall-test", { instanceId: "wall", paneId: "risk-factors" }));
  state.focusedPaneId = "wall";
  return <TestPaneFrame state={state} paneId="wall" pluginId="wall" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
    {(body) => original ? <OriginalWall /> : <WallTeaser placement={placement} width={width} height={body.height}
      title={title} message={message} symbol={symbol}><OriginalWall /></WallTeaser>}
  </TestPaneFrame>;
}

test("pending and control walls preserve the original frame and Upgrade action", async () => {
  await tui.render(<Harness original />);
  const original = await tui.waitForFrameToContain("Upgrade to Pro");
  const answer = Promise.withResolvers<"control" | null>();
  arm(answer.promise);
  await tui.render(<Harness />);
  await tui.waitForFrameToContain("Upgrade to Pro");
  expect(tui.frame()).toBe(original);
  await act(async () => answer.resolve("control"));
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(original);
  await tui.emitKeypress({ name: "return" });
  expect(upgrades).toBe(1);
  await tui.clickFrameText("Upgrade to Pro");
  expect(upgrades).toBe(2);
});

test("a teaser that cannot fit keeps control and records none", async () => {
  arm("teaser");
  await tui.render(<Harness height={7} original />);
  const original = await tui.waitForFrameToContain("Upgrade to Pro");
  await tui.render(<Harness height={7} />);
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(original);
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-wall", "none");
});

test("a ticker switch cannot show the old summary, and an empty summary shows a passive sample", async () => {
  arm("teaser");
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof wallSummary.getWallSummary>>>();
  const summaries = spyOn(wallSummary, "getWallSummary").mockImplementation(async (_wall, symbol) => symbol === "AAPL" ? pending.promise : null);
  restore.push(() => summaries.mockRestore());
  await tui.render(<Harness />);
  await tui.render(<Harness symbol="MSFT" />);
  await tui.waitForFrameToContain("Sample");
  await act(async () => pending.resolve({ kind: "counts", items: [{ label: "risk_count", value: 31 }] }));
  await tui.renderFrames(2);
  expect(tui.frame()).not.toContain("31");
  await tui.emitKeypress({ name: "return" });
  expect(upgrades).toBe(1);
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-wall", "sample");
});

test("real aggregate facts render only after an accepted teaser answer", async () => {
  arm("teaser");
  const summary = spyOn(wallSummary, "getWallSummary").mockResolvedValue({ kind: "counts", items: [
    { label: "risk_count", value: 31 }, { label: "filed_at", value: "2025-10-31" },
  ] });
  restore.push(() => summary.mockRestore());
  await tui.render(<Harness />);
  const frame = await tui.waitForFrameToContain("2025-10-31");
  expect(frame).toContain("31");
  expect(frame).not.toContain("Sample");
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-wall", "summary");
});

test("a sample table leaves the original buttons visible and cannot take their keyboard focus", async () => {
  arm("teaser");
  await tui.render(<Harness placement="most-wall" />);
  const frame = await tui.waitForFrameToContain("Sample");
  expect(frame).toContain("Upgrade to Pro");
  expect(frame).toContain("Manage account");
  await tui.emitKeypress({ name: "return" });
  expect(upgrades).toBe(1);
  await tui.clickFrameText("Upgrade to Pro");
  expect(upgrades).toBe(2);
});

test.each(["most-wall", "flow-wall", "hilo-wall", "srch-wall", "exec-wall", "calls-wall", "jobs-wall"])("%s fills the available rows with stable masks and no readable values", async (placement) => {
  arm("teaser");
  const summary = spyOn(wallSummary, "getWallSummary").mockResolvedValue(null);
  restore.push(() => summary.mockRestore());
  await tui.render(<Harness placement={placement} />);
  const frame = await tui.waitForFrameToContain("░");
  const rows = frame.split("\n").filter((line) => line.includes("░"));
  expect(rows).toHaveLength(8);
  // Headers may contain units such as 30D. Sample values may contain only the
  // frozen ticker identifiers and shade cells, never a number or other text.
  const values = rows.join("\n").replace(/AAPL|MSFT|NVDA|AMZN|TSLA|META|AMD|GOOGL/g, "");
  expect(values.replace(/[░\s]/g, "")).toBe("");
  expect(new Set(values.match(/░+/g)?.map((value) => value.length)).size).toBeGreaterThan(1);
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(frame);

  await tui.render(<Harness placement={placement} width={46} height={14} />);
  await tui.renderFrames(2);
  const small = tui.frame();
  expect(small).toContain("Upgrade to Pro");
  expect(small).toContain("Sample");
  expect(small.split("\n").filter((line) => line.includes("░")).length).toBeLessThan(8);
  expect(small).not.toContain("GOOGL");
});
