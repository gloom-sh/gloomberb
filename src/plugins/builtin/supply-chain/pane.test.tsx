import { act, Profiler, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { supplyChainCache } from "./client";
import { graphCache } from "./graph-client";
import { graphPayload } from "./test-fixture-graph";
import { SupplyChainPane } from "./pane";
import { entity, supplyPayload, supplyRow } from "./test-fixture";

const tui = createOpenTuiTestHarness();
let commits = 0;
const countCommit = () => { if (++commits > 100) throw new Error("Supply chain pane did not settle within 100 React commits"); };
afterEach(() => { setCloudApiFetchTransport(null); supplyChainCache.reset(); graphCache.reset(); });
async function mount(width: number, height: number, tab = "table", view = "says", onNavigate: (id: string, symbol: string | undefined) => void = () => {}, settings: Record<string, unknown> | string = {}) {
  commits = 0;
  supplyChainCache.attach(new MemoryPluginPersistence());
  const id = "supply-chain:test";
  const state = createInitialState(createTestPaneConfig("/home/vince/.cache/gloom-smoke/glo-224/focused-tests", {
    paneId: "supply-chain", instanceId: id, binding: { kind: "fixed", symbol: "FOCUS" }, settings: { tab, view, ...(typeof settings === "string" ? { tiers: settings } : settings) },
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
    <PaneKeyboardScrollController paneId={id} focused />
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
  expect(frame).toContain("Upgrade to Pro");
  expect(frame).not.toContain("Suppliers");
  await tui.destroy();
  data.says[0] = supplyRow("Known company", { nativeAmount: 315_813, nativeCurrency: "JPY", nativeScale: 1_000_000 });
  await mount(88, 20);
  const native = await tui.waitForFrameToContain("315,813 JPY million");
  expect(native).toContain("2026-01-31");
  expect(native).toContain("Upgrade to Pro");
  expect(native).toContain("Filing");
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



test("narrow evidence wraps original quotes and glosses and scrolls to their ends", async () => {
  const row = supplyRow("Korean disclosure", { quoteLanguage: "ko", pctOfRevenue: null, pctBasis: null,
    quote: "2025년 당사의 주요 매출처는 Alphabet, Apple, Deutsche Telekom, Hong Kong Techtronics, Supreme Electronics 등(알파벳순) 입니다. 당사의 주요 5대 매출처에 대한 매출비중은 전체 매출액 대비 약 15% 수준입니다.",
    quoteGloss: "Samsung's principal customers include Alphabet, Apple, Deutsche Telekom, Hong Kong Techtronics and Supreme Electronics. Together they represented approximately 15% of total revenue." });
  setCloudApiFetchTransport(async () => Response.json(supplyPayload({ says: [row] })));
  await mount(80, 20);
  await tui.waitForFrameToContain("2026-01-31");
  await tui.emitKeypress({ name: "e" });
  await tui.waitForFrameToContain("Original quote");
  await tui.emitKeypress({ name: "end" });
  const frame = await tui.waitForFrameToContain(`Open ${row.form}`);
  expect(frame).toContain("15% 수준입니다.");
  expect(frame).toContain("15% of total revenue.");
  expect(frame).toContain("English gloss · machine translation");
});


test("evidence preserves the reporting company and scope, then Enter drills into the selected counterparty", async () => {
  const row = supplyRow("counterparty", { counterparty: { ...entity("counterparty"), ticker: "2330", exchange: "TWSE" }, pctScope: "Business segments: Compute and networking",
    nativeAmount: 315_813, nativeCurrency: "JPY", nativeScale: 1_000_000, quoteLanguage: "ja", quote: "販売高には、当該顧客と同一の企業集団に属する顧客に対する販売高を含めております。",
    quoteGloss: "Sales include customers in the same corporate group.", entityScope: "group" });
  setCloudApiFetchTransport(async () => Response.json(supplyPayload({ says: [row] })));
  const opened: Array<[string, string | undefined]> = [];
  for (const width of [88, 160]) {
    await mount(width, 24);
    const table = await tui.waitForFrameToContain("315,813 JPY million");
    expect(table).toContain("2026-01-31");
    expect(table).toContain("22%");
    if (width === 160) expect(table).toContain("ORIGINS");
    await tui.destroy();
  }
  await mount(120, 30, "table", "says", (template, symbol) => opened.push([template, symbol]));
  await tui.waitForFrameToContain("counterparty");
  await tui.emitKeypress({ name: "e" });
  const evidence = await tui.waitForFrameToContain("Percentage scope");
  expect(evidence).toContain("Business segments: Compute and networking");
  expect(evidence).toContain("Reporting company");
  expect(evidence).toContain("Metric scope");
  expect(evidence).toContain("Corporate group");
  expect(evidence).toContain(row.quote);
  expect(evidence).toContain("315,813 JPY million");
  expect(evidence).toContain("Original quote · Japanese");
  expect(evidence).toContain("English gloss · machine translation");
  expect(evidence).toContain(row.quoteGloss!);
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("COUNTERPARTY");
  await tui.emitKeypress({ name: "return" });
  expect(opened).toEqual([["supply-chain-pane", "2330:TWSE"]]);
});


test("graph selection collapses a branch and recenters an unlisted company through its stable ID", async () => {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (input) => { requests.push(String(input)); return Response.json(graphPayload()); });
  await mount(120, 24, "graph", "says", () => {}, { tiers: "primary" });
  await tui.waitForFrameToContain("Private supplier");
  await tui.emitKeypress({ name: "j" });
  await tui.emitKeypress({ name: "c" });
  const collapsed = await tui.waitForFrameToContain("+ Private supplier");
  expect(collapsed).not.toContain("Tier two");
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("Tier two");
  await tui.emitKeypress({ name: "return" });
  await tui.renderFrames(3);
  expect(requests.some(url => url.includes("id%3A2/graph"))).toBe(true);
  expect(requests.every(url => url.includes("/graph?") && url.includes("tiers=primary"))).toBe(true);
});

test("path evidence preserves every hop and opens the filter form without losing the route", async () => {
  const data = graphPayload(); data.paths = [data.upstream[1]!.bestPath]; data.target = data.nodes[2]!; data.upstream = [];
  Object.assign(data.links[0]!.evidence[0]!, { pctOfRevenue: 22, pctBasis: "revenue", pctScope: "Compute And Networking Segment" });
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(120, 27, "path", "says", () => {}, { to: "3" });
  await tui.waitForFrameToContain("ROUTE");
  await tui.emitKeypress({ name: "return" });
  const frame = await tui.waitForFrameToContain("Estimated exposure");
  expect(frame).toContain("20% est. of 1 revenue");
  expect(frame).toContain("of 1 Compute & Networking revenue");
  expect(frame).toContain("We depend on this supplier.");
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("ROUTE");
  await tui.emitKeypress({ name: "i" });
  expect(await tui.waitForFrameToContain("Minimum disclosed percentage")).toContain("Apply filters");
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("ROUTE");
});

test("narrow path evidence retains native scale and scrolls through CJK quotes, glosses and attribution", async () => {
  const data = graphPayload(); data.paths = [data.upstream[0]!.bestPath]; data.target = data.nodes[1]!; data.upstream = [];
  // Synthetic contract fixture; the real global corpus determines which routes exist.
  Object.assign(data.links[0]!.evidence[0]!, { nativeAmount: 315_813, nativeCurrency: "JPY", nativeScale: 1_000_000,
    entityScope: "group", jurisdiction: "JP", sectionRef: "販売実績", quoteLanguage: "ja",
    quote: "販売高には当該顧客と同一の企業集団に属する顧客に対する販売高を含めております。販売高には当該顧客と同一の企業集団に属する顧客に対する販売高を含めております。原文末尾。",
    quoteGloss: "Sales include customers in the same corporate group. This translation is separate from the original quotation. End of translation.",
    sourceAttribution: "EDINET PDL1.0; extracted data edited by Gloom." });
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(80, 26, "path", "says", undefined, { to: "2" });
  await tui.waitForFrameToContain("ROUTE");
  await tui.emitKeypress({ name: "return" });
  const initial = await tui.waitForFrameToContain("315,813 JPY million");
  expect(initial).toContain("Corporate group");
  expect(initial).toContain("販売実績");
  expect(initial).not.toContain("$315,813");
  await tui.emitKeypress({ name: "end" });
  const end = await tui.waitForFrameToContain("EDINET PDL1.0");
  expect(end).toContain("原文末尾。");
  expect(end).toContain("End of translation.");
  expect(end).toContain("English gloss · machine translation");
  expect(end).toContain("Open source filing");
});

test("graph paging keys reach companies outside the first layer page", async () => {
  const data = graphPayload(), base = data.nodes[1]!, baseLink = data.links[0]!;
  data.nodes = [data.nodes[0]!]; data.links = []; data.upstream = [];
  for (let i = 0; i < 9; i++) {
    const id = `supplier-${i}`;
    data.nodes.push({ ...base, id, name: `Supplier ${i}` });
    data.links.push({ ...baseLink, id, from: id });
    const path = { id: `upstream|${id}`, nodeIds: ["1", id], linkIds: [id], hops: 1, score: 1 - i / 100, confidence: .9, exposure: null };
    data.upstream.push({ entityId: id, direction: "upstream", hops: 1, bestPath: path, shortestPath: path });
  }
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(100, 16, "graph");
  await tui.waitForFrameToContain("Supplier 0");
  await tui.emitKeypress({ name: "]", sequence: "]" });
  const second = await tui.waitForFrameToContain("Supplier 3");
  expect(second).not.toContain("Supplier 0");
  await tui.emitKeypress({ name: "[", sequence: "[" });
  await tui.waitForFrameToContain("Supplier 0");
});

test("a narrow graph reveals keyboard-selected nodes outside its initial horizontal viewport", async () => {
  const data = graphPayload(); data.nodes[0]!.ticker = "FOCUS"; data.nodes[2]!.ticker = "LEFTMOST";
  setCloudApiFetchTransport(async () => Response.json(data));
  await mount(40, 20, "graph");
  await tui.waitForFrameToContain("FOCUS");
  await tui.emitKeypress({ name: "j" });
  await tui.emitKeypress({ name: "k" });
  expect(await tui.waitForFrameToContain("LEFTMOST")).toContain("2H · supplier");
});
