import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { powerBoardCache, powerDetailCache, powerHistoryCache } from "./client";
import { PowerPane } from "./pane";
import { powerBoard, powerPoint, powerProject } from "./test-fixture";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); for (const cache of [powerBoardCache, powerDetailCache, powerHistoryCache]) cache.reset(); });
async function mount(tab = "queue", navigate: (id: string, symbol: string | undefined) => void = () => {}) {
  for (const cache of [powerBoardCache, powerDetailCache, powerHistoryCache]) cache.attach(new MemoryPluginPersistence());
  const id = "power:test";
  const state = createInitialState(createTestPaneConfig("/tmp/power-test", { paneId: "power", instanceId: id, settings: { tab } }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="market-overview" runtime={createTestPluginRuntime({ createPaneFromTemplate: (template, options) => navigate(template, options?.symbol ?? undefined) })}>
      <PaneFooterProvider>{(footer) => <Box width={120} height={28} flexDirection="column">
        <Box height={27}><PowerPane paneId={id} paneType="power" width={120} height={27} focused /></Box>
        <PaneFooterBar footer={footer} width={120} focused /><PaneFooterKeys paneId={id} footer={footer} focused />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 120, height: 28 }); });
}
test("project opens supported evidence in a stack and ticker action preserves its exchange", async () => {
  const row = powerProject(); const board = powerBoard();
  const evidenceOffsets: number[] = [];
  setCloudApiFetchTransport(async (input) => {
    if (!String(input).includes("/projects/")) return Response.json(board);
    const offset = Number(new URL(String(input)).searchParams.get("offset") ?? 0); evidenceOffsets.push(offset);
    return Response.json({ generatedAt: board.generatedAt, access: "full", project: row,
      revisions: [powerProject({ revision: offset ? 1 : 2, snapshotId: `snapshot:${offset}` })], totalRevisions: 2,
      hasMore: offset === 0, nextOffset: offset === 0 ? 1 : null, locked: 0 });
  });
  const opened: Array<[string, string | undefined]> = [];
  await mount("queue", (id, symbol) => opened.push([id, symbol]));
  await tui.waitForFrameToContain("Storage project");
  await tui.emitKeypress({ name: "d" });
  expect(opened).toEqual([["new-ticker-detail-pane", "NEE:XNYS"]]);
  await tui.emitKeypress({ name: "return" });
  const frame = await tui.waitForFrameToContain("Primary Evidence");
  expect(frame).toContain("Sheet 1 row 3");
  expect(frame).toContain("Observed UTC");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(evidenceOffsets).toEqual([0, 1]);
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("Storage project")).toContain("PROJECT");
});
test("preview keeps primary records and standard locks without treating preview totals as full statistics", async () => {
  setCloudApiFetchTransport(async () => Response.json(powerBoard({ access: "preview", total: 30, locked: { projects: 29, aggregates: 0, rates: 0, exposure: 0 } })));
  await mount();
  const frame = await tui.waitForFrameToContain("Unlock with Pro");
  expect(frame).toContain("Storage project");
  expect(frame).not.toContain("Active MW");
});

test("history distinguishes actual observations from published years and renders their source details", async () => {
  const board = powerBoard();
  const historyOffsets: number[] = [];
  setCloudApiFetchTransport(async (input) => {
    if (!String(input).includes("/history")) return Response.json(board);
    const offset = Number(new URL(String(input)).searchParams.get("offset") ?? 0); historyOffsets.push(offset);
    return Response.json({ generatedAt: board.generatedAt, access: "full", locked: 0, hasMore: offset < 2, nextOffset: offset < 2 ? offset + 1 : null,
      points: [powerPoint({ basis: "published", historical: true, period: String(2025 - offset), capacityMw: 2025 - offset })] });
  });
  await mount("history");
  const frame = await tui.waitForFrameToContain("2023");
  expect(historyOffsets).toEqual([0, 1, 2]);
  expect(frame).toContain("2025");
  expect(frame).toContain("2,025");
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("Published period");
  expect(detail).toContain("Observed UTC");
  expect(detail).toContain("Open primary document");
});
