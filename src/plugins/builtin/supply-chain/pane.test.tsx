import { act, Profiler, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { supplyChainCache } from "./client";
import { SupplyChainPane } from "./pane";
import { entity, supplyPayload, supplyRow } from "./test-fixture";

const tui = createOpenTuiTestHarness();
let commits = 0;
const countCommit = () => { if (++commits > 100) throw new Error("Supply chain pane did not settle within 100 React commits"); };
afterEach(() => { setCloudApiFetchTransport(null); supplyChainCache.reset(); });
async function mount(width: number, height: number, tab = "table", view = "says", onNavigate: (id: string, symbol: string | undefined) => void = () => {}, tiers = "sec,company,call") {
  commits = 0;
  supplyChainCache.attach(new MemoryPluginPersistence());
  const id = "supply-chain:test";
  const state = createInitialState(createTestPaneConfig("/home/vince/.cache/gloom-smoke/splc-layer2a/focused", {
    paneId: "supply-chain", instanceId: id, binding: { kind: "fixed", symbol: "FOCUS" }, settings: { tab, view, tiers },
  }));
  state.tickers.set("FOCUS", createTestTicker("FOCUS", "Focus Company"));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime({ createPaneFromTemplate: (template, options) => onNavigate(template, options?.symbol ?? undefined) })}>
    <PaneFooterProvider>{(footer) => <Box width={width} height={height} flexDirection="column">
      <Box height={height - 1}><Profiler id="supply-pane" onRender={countCommit}><SupplyChainPane paneId={id} paneType="supply-chain" width={width} height={height - 1} focused /></Profiler></Box>
      <PaneFooterBar footer={footer} width={width} focused />
      <PaneFooterKeys paneId={id} footer={footer} focused />
    </Box>}</PaneFooterProvider>
  </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
}

test("initial tier fallback and changing the evidence filter settle without a cached loader render loop", async () => {
  setCloudApiFetchTransport(async () => Response.json(supplyPayload()));
  await mount(150, 26);
  await tui.waitForFrameToContain("customer");
  await tui.renderFrames(5);
  expect(commits).toBeLessThan(30);
  await act(async () => { await tui.clickFrameText("3 selected"); });
  await tui.waitForFrameToContain("Reported");
  await act(async () => { await tui.clickFrameText("Reported"); });
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("4 selected");
  await tui.renderFrames(5);
  expect(commits).toBeLessThan(60);
});

test("preview keeps evidence-bearing rows, shows the standard upgrade, and narrow flow falls back to table", async () => {
  const data = supplyPayload({ says: [supplyRow("Known company")], access: "preview", lockedRows: 5, truncated: true, previewRowsPerRole: 3, totalRows: 6 });
  data.counts.says.customer = 6;
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(65, 17, "flow");
  const frame = await tui.waitForFrameToContain("Known company");
  expect(frame).toContain("COUNTERPARTY");
  expect(frame).toContain("Upgrade to see every relationship");
  expect(frame).not.toContain("Suppliers");
});

test("Unconfirmed opt-in separates reported leads from confirmed rows and excludes them from flow", async () => {
  const data = supplyPayload({ says: [supplyRow("Current buyer"), supplyRow("Pending buyer", { tier: 4, leadStatus: "lead", whyUnconfirmed: "Single source, in talks" })], totalRows: 2 });
  data.counts.says.customer = 2;
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(150, 26);
  expect(await tui.waitForFrameToContain("Current buyer")).not.toContain("Pending buyer");
  await tui.destroy();
  await mount(150, 26, "table", "says", undefined, "sec,unconfirmed");
  const table = await tui.waitForFrameToContain("Pending buyer");
  expect(table).toContain("Unconfirmed (1)");
  expect(table.indexOf("Current buyer")).toBeLessThan(table.indexOf("Unconfirmed (1)"));
  await tui.destroy();
  await mount(150, 26, "flow", "says", undefined, "sec,unconfirmed");
  expect(await tui.waitForFrameToContain("Current buyer")).not.toContain("Pending buyer");
});

test("reverse table labels the percentage denominator and diagram pages a crowded supplier band", async () => {
  const names = Array.from({ length: 70 }, (_, i) => supplyRow(`Supplier ${String(i).padStart(2, "0")}`, { role: "supplier", direction: "in" }));
  const data = supplyPayload({ says: [], names, totalRows: names.length });
  data.counts.says.customer = 0; data.counts.names.supplier = 70;
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(120, 28, "table", "names");
  expect(await tui.waitForFrameToContain("Supplier 00")).toContain("% of reporting company's basis");
  await tui.destroy();
  await mount(120, 28, "flow", "names");
  const frame = await tui.waitForFrameToContain("Suppliers");
  const more = frame.match(/\+\d+ more/)?.[0];
  expect(more).toBeDefined();
  expect(frame).toContain("Supplier 00");
  await act(async () => { await tui.clickFrameText(more!); });
  const next = await tui.waitForFrameToContain(`Supplier ${String(70 - Number(more!.match(/\d+/)![0])).padStart(2, "0")}`);
  expect(next).not.toContain("Supplier 00");
});


test("evidence preserves the reporting company and scope, then Enter drills into the selected counterparty", async () => {
  const row = supplyRow("counterparty", { counterparty: { ...entity("counterparty"), ticker: "2330", exchange: "TWSE" }, pctScope: "Business segments: Compute and networking" });
  setCloudApiFetchTransport(async () => Response.json(supplyPayload({ says: [row] })));
  const opened: Array<[string, string | undefined]> = [];
  await mount(120, 24, "table", "says", (template, symbol) => opened.push([template, symbol]));
  await tui.waitForFrameToContain("counterparty");
  await tui.emitKeypress({ name: "e" });
  const evidence = await tui.waitForFrameToContain("Percentage scope");
  expect(evidence).toContain("Business segments: Compute and networking");
  expect(evidence).toContain("Reporting company");
  expect(evidence).toContain(row.quote);
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("COUNTERPARTY");
  await tui.emitKeypress({ name: "return" });
  expect(opened).toEqual([["supply-chain-pane", "2330:TWSE"]]);
});
