import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import type { CpiBoardPayload } from "../../../api-client/cpi";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cpiBoardCache } from "./client";
import fixture from "./board.fixture.json";
import { CpiPane } from "./pane";
import { cpiHeadless } from "./headless";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); cpiBoardCache.reset(); });

const ALL_ITEMS_READ = "All items rose 0.6% in September and 3.7% over the year; core rose 0.3% and 2.6%.";
const LONGEST_READ = "Education and communication moved the 0.6% rise by less than 0.01 points and is 5.0% of the basket.";

async function mount(width: number, height: number, row?: string, board = structuredClone(fixture) as unknown as CpiBoardPayload) {
  cpiBoardCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(board));
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

test("a release without annual contributions omits the column, and one contribution restores it", async () => {
  const board = structuredClone(fixture) as unknown as CpiBoardPayload;
  for (const row of board.rows) row.contributionYoy = null;
  await mount(140, 36, undefined, board);
  expect(await tui.waitForFrameToContain("COMPONENT")).not.toContain("Y/Y PTS");
  await exportPaneTable("cpi:test", "cpi.csv");
  expect(takeSavedTextFile()?.text).toContain("Y/Y Pts");
  const report = await cpiHeadless.load(createTestHeadlessArgs(), createTestHeadlessContext({ apiClient }));
  expect(report.sections[0]?.columns?.some((column) => column.key === "contributionYear")).toBe(true);
  expect(report.sections[0]?.rows?.every((row) => row.contributionYear === null)).toBe(true);
  await tui.destroy();
  cpiBoardCache.reset();
  board.rows.find((row) => row.id === "core")!.contributionYoy = 0;
  await mount(140, 36, undefined, board);
  const frame = await tui.waitForFrameToContain("Y/Y PTS");
  expect(frame).toContain("0.00");
  expect(board.rows.find((row) => row.id === "food")!.contributionYoy).toBeNull();
});

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

test("a narrow pane keeps the release whole and every figure in view: the next release and the names give way", async () => {
  // At 70 columns the stamp was cut in its middle and M/M Pts and Y/Y Pts scrolled out of view.
  await mount(68, 36);
  for (const marker of ["COMPONENT", "Y/Y PTS"]) {
    await tui.setup().renderOnce();
    const frame = await tui.waitForFrameToContain(marker);
    const header = frame.split("\n").find((line) => line.includes("COMPONENT"))!;
    expect(header).toContain("M/M PTS");
    expect(header).toContain("Y/Y PTS");
    expect(frame).not.toContain("⇧→");
    expect(frame).toMatch(/Sep 2026 · released \w{3} \d{1,2} \w{3} 08:30 ET/);
  }
});
