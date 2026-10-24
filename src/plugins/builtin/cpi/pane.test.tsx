import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { CpiBoardPayload } from "../../../api-client/cpi";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cpiBoardCache } from "./client";
import fixture from "./board.fixture.json";
import { CpiPane } from "./pane";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); cpiBoardCache.reset(); });

const ALL_ITEMS_READ = "All items rose 0.6% in September and 3.7% over the year; core rose 0.3% and 2.6%.";
const LONGEST_READ = "Education and communication moved the 0.6% rise by less than 0.01 points and is 5.0% of the basket.";

async function mount(width: number, height: number, row?: string) {
  cpiBoardCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(structuredClone(fixture) as unknown as CpiBoardPayload));
  const id = "cpi:test";
  const state = createInitialState(createTestPaneConfig("/tmp/cpi-pane-test", { paneId: "cpi", instanceId: id, params: row ? { row } : undefined }));
  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId={id} pluginId="cpi" runtime={createTestPluginRuntime()}>
        <CpiPane paneId={id} paneType="cpi" width={width} height={height} focused />
      </TestPaneProvider>,
      { width, height },
    );
  });
}

/** The chart band's read: the rows under the axis line, up to the table's header. */
function readUnderChart(frame: string): string {
  const lines = frame.split("\n");
  const start = lines.findIndex((line) => /\b20\d\d\b.*\b20\d\d\b/.test(line)) + 1;
  const end = lines.findIndex((line) => line.includes("COMPONENT"));
  return lines.slice(start, end).map((line) => line.trim()).join(" ");
}

test("a read longer than the pane wraps under the chart instead of ending in dots", async () => {
  await mount(80, 24);
  const frame = await tui.waitForFrameToContain("COMPONENT");
  expect(readUnderChart(frame)).toBe(ALL_ITEMS_READ);
  expect(frame).not.toContain("...");
  // The chart keeps its band, with its plot and legend, beside the wrapped read.
  expect(frame).toContain("All items m/m");
});

test("the longest read wraps whole at 80 columns, and a wide pane keeps it on one row", async () => {
  await mount(80, 24, "education-communication");
  expect(readUnderChart(await tui.waitForFrameToContain("COMPONENT"))).toBe(LONGEST_READ);
  await tui.destroy();
  await mount(140, 30, "education-communication");
  const wide = await tui.waitForFrameToContain("COMPONENT");
  expect(wide.split("\n").filter((line) => line.includes(LONGEST_READ))).toHaveLength(1);
});
