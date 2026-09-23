import { afterAll, afterEach, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { mkdirSync, writeFileSync } from "node:fs";
const source = process.env.FILING_SOURCE ?? new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const out = process.env.FILING_OUT;
if (out)
    mkdirSync(out, { recursive: true });
const { apiClient, setCloudApiFetchTransport } = await import(`${source}/src/api-client`);
const { FilingEventsPane } = await import(`${source}/src/plugins/builtin/filing-events/pane`);
const { TestPaneProvider, createTestPaneConfig, createTestTicker } = await import(`${source}/src/test-support/pane`);
const { createStatefulTestPluginRuntime } = await import(`${source}/src/test-support/plugin-runtime`);
const { createInitialState } = await import(`${source}/src/state/app/context`);
const { PaneFooterProvider, PaneFooterBar } = await import(`${source}/src/components/layout/pane/footer`);
const { testRender, settleFrame, emitKeypress } = await import(`${source}/src/renderers/opentui/test-utils`);
const { Box, UiHostProvider, useRendererHost, useUiHost, useNativeRenderer } = await import(`${source}/src/ui`);
let setup: any, footer: any, selectCompany: (symbol: string) => void;
let requests: string[] = [];
let opened: string[] = [];
const observations: any[] = [];
let frames = 0;
function event(ticker: string, id = ticker) { return { id, ticker, company: { ticker, cik: ticker === "FIRST" ? "1" : "2", name: `${ticker} issuer`, shortName: ticker }, filingDate: "2026-09-10", filedAt: "2026-09-10T20:30:00Z", docUrl: `https://www.sec.gov/Archives/${ticker}/${id}.htm`, items: ["1.01"], labels: ["Material agreement"], kinds: ["agreement"], material: true, headline: `${ticker} acquisition terms`, summary: `${ticker} paid 20 million in cash.`, people: [], read: true }; }
function Harness() { const [symbol, setSymbol] = useState("FIRST"); selectCompany = setSymbol; const config = createTestPaneConfig("/tmp/unused-filing-research", { instanceId: "filing-audit", paneId: "filing-events", binding: { kind: "fixed", symbol } }); const state = createInitialState(config); state.tickers = new Map([[symbol, createTestTicker(symbol)]]); state.focusedPaneId = "filing-audit"; const runtime = useMemo(() => createStatefulTestPluginRuntime(), []); const host = useRendererHost(); const ui = useUiHost(); const native = useNativeRenderer(); return <UiHostProvider ui={ui} nativeRenderer={native} renderer={{ ...host, openExternal: async (url: string) => { opened.push(url); } }}><TestPaneProvider state={state} paneId="filing-audit" pluginId="ticker-research" runtime={runtime}><PaneFooterProvider>{(value: any) => { footer = value; return <Box width={100} height={24} flexDirection="column"><Box height={23}><FilingEventsPane focused width={100} height={23}/></Box><PaneFooterBar footer={value} focused width={100}/></Box>; }}</PaneFooterProvider></TestPaneProvider></UiHostProvider>; }
function transport(fn: (ticker: string) => Response | Promise<Response>) { setCloudApiFetchTransport((async (input: any) => { const url = new URL(String(input)); if (!url.pathname.startsWith("/public/events/"))
    throw new Error(`Unexpected controlled route ${url.pathname}`); requests.push(url.pathname); return fn(decodeURIComponent(url.pathname.split("/").at(-1)!)); }) as typeof fetch); }
async function mount() { await act(async () => { setup = await testRender(<Harness />, { width: 100, height: 24 }); }); await settleFrame(setup, 8); }
async function select(symbol: string) { await act(async () => selectCompany(symbol)); await settleFrame(setup, 6); }
function capture(name: string) { const frame = setup.captureCharFrame(); frames++; if (out) {
    writeFileSync(`${out}/${name}.txt`, frame);
    writeFileSync(`${out}/${name}-footer.json`, JSON.stringify(footer, null, 2));
} return frame; }
afterEach(async () => { if (setup)
    await act(async () => setup.renderer.destroy()); setup = null; setCloudApiFetchTransport(null); apiClient.dispose(); requests = []; opened = []; });
afterAll(() => { if (out)
    writeFileSync(`${out}/observations.json`, JSON.stringify({ source, frames, observations }, null, 2)); });
test("pending company changes hide previous issuer content and source actions", async () => {
    let resolveSecond!: (response: Response) => void;
    transport(ticker => ticker === "FIRST" ? Response.json({ ticker, events: [event(ticker)] }) : new Promise(resolve => resolveSecond = resolve));
    await mount();
    expect(capture("company-first")).toContain("FIRST acquisition terms");
    await select("SECOND");
    expect(capture("company-second-pending")).not.toContain("FIRST acquisition terms");
    await emitKeypress(setup, { name: "o", sequence: "o" });
    expect(opened).toEqual([]);
    await act(async () => resolveSecond(Response.json({ ticker: "SECOND", events: [event("SECOND")] })));
    await settleFrame(setup, 8);
    expect(capture("company-second-loaded")).toContain("SECOND acquisition terms");
    observations.push({ case: "pending-company-ownership", requests: [...requests], opened: [...opened] });
});
test("clearing the company removes its filing open shortcut", async () => {
    transport(ticker => Response.json({ ticker, events: [event(ticker)] }));
    await mount();
    await select("");
    capture("company-cleared");
    await emitKeypress(setup, { name: "o", sequence: "o" });
    expect(opened).toEqual([]);
    observations.push({ case: "cleared-company-ownership", opened: [...opened], footer });
});
test("plain refresh retries an initial outage and loads current filings", async () => {
    let recovered = false;
    transport(ticker => recovered ? Response.json({ ticker, events: [event(ticker)] }) : new Response("Controlled filing outage", { status: 503 }));
    await mount();
    expect(capture("initial-outage")).toContain("Could not load 8-K filings");
    recovered = true;
    const count = requests.length;
    await emitKeypress(setup, { name: "r", sequence: "r" });
    await settleFrame(setup, 8);
    expect(requests.length).toBe(count + 1);
    expect(capture("outage-refresh")).toContain("FIRST acquisition terms");
    observations.push({ case: "refresh-outage", requests: [...requests] });
});
test("same-company refresh preserves selection and source during transient failure, then recovers", async () => {
    let mode = "initial";
    transport(ticker => mode === "failed" ? new Response("Controlled refresh outage", { status: 503 }) : Response.json({ ticker, events: mode === "recovered" ? [event(ticker, "new"), event(ticker, "kept")] : [event(ticker, "kept")] }));
    await mount();
    const initialRows = setup.captureCharFrame().split("\n");
    const row = initialRows.findIndex((line: string) => line.includes("FIRST acquisition terms"));
    await act(async () => setup.mockMouse.click(initialRows[row].indexOf("FIRST acquisition terms") + 2, row));
    await settleFrame(setup, 4);
    mode = "failed";
    await emitKeypress(setup, { name: "r", sequence: "r" });
    await settleFrame(setup, 8);
    expect(capture("refresh-retained")).toContain("FIRST acquisition terms");
    expect(JSON.stringify(footer)).toContain("Controlled refresh outage");
    await emitKeypress(setup, { name: "o", sequence: "o" });
    expect(opened.at(-1)).toContain("/kept.htm");
    mode = "recovered";
    await emitKeypress(setup, { name: "r", sequence: "r" });
    await settleFrame(setup, 8);
    expect(capture("refresh-recovered").split("FIRST acquisition terms").length - 1).toBe(2);
    expect(JSON.stringify(footer)).not.toContain("Controlled refresh outage");
    await emitKeypress(setup, { name: "o", sequence: "o" });
    expect(opened.at(-1)).toContain("/kept.htm");
});
test("obsolete company response cannot overwrite a newer company or restore its source action", async () => {
    let pending!: (response: Response) => void;
    transport(ticker => ticker === "SECOND" ? new Promise(resolve => pending = resolve) : Response.json({ ticker, events: [event(ticker)] }));
    await mount();
    await select("SECOND");
    await select("THIRD");
    await act(async () => pending(Response.json({ ticker: "SECOND", events: [event("SECOND")] })));
    await settleFrame(setup, 8);
    const frame = capture("company-race");
    expect(frame).toContain("THIRD acquisition terms");
    expect(frame).not.toContain("SECOND acquisition terms");
    await emitKeypress(setup, { name: "o", sequence: "o" });
    expect(opened.at(-1)).toContain("/THIRD/");
});
test("page keys move the selection a screen at a time and Enter opens it", async () => {
    transport(ticker => Response.json({ ticker, events: Array.from({ length: 12 }, (_, index) => event(ticker, `f${index}`)) }));
    await mount();
    const openSelected = async () => { await emitKeypress(setup, { name: "return" }); return Number(/f(\d+)\.htm$/.exec(opened.at(-1) ?? "")?.[1]); };
    const end = await emitKeypress(setup, { name: "end" }, { trackPropagation: true });
    expect(end.defaultPrevented).toBe(true);
    expect(await openSelected()).toBe(11);
    await emitKeypress(setup, { name: "home" });
    expect(await openSelected()).toBe(0);
    await emitKeypress(setup, { name: "pagedown" });
    const paged = await openSelected();
    expect(paged).toBeGreaterThan(1);
    await emitKeypress(setup, { name: "pageup" });
    expect(await openSelected()).toBe(0);
    // With nothing further to select, the key is left to scroll the feed.
    const top = await emitKeypress(setup, { name: "k" }, { trackPropagation: true });
    expect(top.defaultPrevented).toBe(false);
});
