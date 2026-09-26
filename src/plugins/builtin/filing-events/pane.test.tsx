import { afterEach, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { apiClient, setCloudApiFetchTransport, type CloudFilingEventPayload } from "../../../api-client";
import { PaneFooterBar, PaneFooterProvider, type CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { emitKeypress, settleFrame, testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, UiHostProvider, useNativeRenderer, useRendererHost, useUiHost } from "../../../ui";
import { FilingEventsPane } from "./pane";

const PANE_ID = "filing-events:test";
let setup: Awaited<ReturnType<typeof testRender>> | null = null;
let footer: CombinedPaneFooter;
let selectCompany: (symbol: string) => void;
let requests: string[] = [];
let opened: string[] = [];

function event(ticker: string, id = ticker): CloudFilingEventPayload {
  return {
    id,
    ticker,
    company: { ticker, cik: ticker === "FIRST" ? "1" : "2", name: `${ticker} issuer`, shortName: ticker },
    filingDate: "2026-09-10",
    filedAt: "2026-09-10T20:30:00Z",
    docUrl: `https://www.sec.gov/Archives/${ticker}/${id}.htm`,
    items: ["1.01"],
    labels: ["Material agreement"],
    kinds: ["agreement"],
    material: true,
    headline: `${ticker} acquisition terms`,
    summary: `${ticker} paid 20 million in cash.`,
    people: [],
    read: true,
  };
}

function Harness() {
  const [symbol, setSymbol] = useState("FIRST");
  selectCompany = setSymbol;
  const config = createTestPaneConfig("/tmp/gloomberb-filing-events-test", {
    instanceId: PANE_ID,
    paneId: "filing-events",
    binding: { kind: "fixed", symbol },
  });
  const state = createInitialState(config);
  state.tickers = new Map([[symbol, createTestTicker(symbol)]]);
  state.focusedPaneId = PANE_ID;
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  const host = useRendererHost();
  const ui = useUiHost();
  const native = useNativeRenderer();
  const renderer = { ...host, openExternal: async (url: string) => { opened.push(url); } };
  return (
    <UiHostProvider ui={ui} nativeRenderer={native} renderer={renderer}>
      <TestPaneProvider state={state} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime}>
        <PaneFooterProvider>
          {(value) => {
            footer = value;
            return (
              <Box width={100} height={24} flexDirection="column">
                <Box height={23}><FilingEventsPane focused width={100} height={23} /></Box>
                <PaneFooterBar footer={value} focused width={100} />
              </Box>
            );
          }}
        </PaneFooterProvider>
      </TestPaneProvider>
    </UiHostProvider>
  );
}

function transport(respond: (ticker: string) => Response | Promise<Response>) {
  setCloudApiFetchTransport((async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/public/events/")) throw new Error(`Unexpected route ${url.pathname}`);
    requests.push(url.pathname);
    return respond(decodeURIComponent(url.pathname.split("/").at(-1)!));
  }) as typeof fetch);
}

async function mount() {
  await act(async () => { setup = await testRender(<Harness />, { width: 100, height: 24 }); });
  await settleFrame(setup!, 8);
}

async function select(symbol: string) {
  await act(async () => selectCompany(symbol));
  await settleFrame(setup!, 6);
}

function frame() {
  return setup!.captureCharFrame();
}

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = null;
  setCloudApiFetchTransport(null);
  apiClient.dispose();
  requests = [];
  opened = [];
});

test("pending company changes hide previous issuer content and source actions", async () => {
  let resolveSecond!: (response: Response) => void;
  transport((ticker) => ticker === "FIRST"
    ? Response.json({ ticker, events: [event(ticker)] })
    : new Promise((resolve) => { resolveSecond = resolve; }));
  await mount();
  expect(frame()).toContain("FIRST acquisition terms");

  await select("SECOND");
  expect(frame()).not.toContain("FIRST acquisition terms");
  await emitKeypress(setup!, { name: "o", sequence: "o" });
  expect(opened).toEqual([]);

  await act(async () => resolveSecond(Response.json({ ticker: "SECOND", events: [event("SECOND")] })));
  await settleFrame(setup!, 8);
  expect(frame()).toContain("SECOND acquisition terms");
});

test("clearing the company removes its filing open shortcut", async () => {
  transport((ticker) => Response.json({ ticker, events: [event(ticker)] }));
  await mount();
  await select("");
  await emitKeypress(setup!, { name: "o", sequence: "o" });
  expect(opened).toEqual([]);
});

test("plain refresh retries an initial outage and loads current filings", async () => {
  let recovered = false;
  transport((ticker) => recovered
    ? Response.json({ ticker, events: [event(ticker)] })
    : new Response("Filing outage", { status: 503 }));
  await mount();
  expect(frame()).toContain("Could not load 8-K filings");

  recovered = true;
  const count = requests.length;
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  await settleFrame(setup!, 8);
  expect(requests.length).toBe(count + 1);
  expect(frame()).toContain("FIRST acquisition terms");
});

test("same-company refresh preserves selection and source during transient failure, then recovers", async () => {
  let mode: "initial" | "failed" | "recovered" = "initial";
  transport((ticker) => {
    if (mode === "failed") return new Response("Refresh outage", { status: 503 });
    const events = mode === "recovered" ? [event(ticker, "new"), event(ticker, "kept")] : [event(ticker, "kept")];
    return Response.json({ ticker, events });
  });
  await mount();
  const initialRows = frame().split("\n");
  const row = initialRows.findIndex((line) => line.includes("FIRST acquisition terms"));
  await act(async () => setup!.mockMouse.click(initialRows[row]!.indexOf("FIRST acquisition terms") + 2, row));
  await settleFrame(setup!, 4);

  mode = "failed";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  await settleFrame(setup!, 8);
  expect(frame()).toContain("FIRST acquisition terms");
  expect(JSON.stringify(footer)).toContain("Refresh outage");
  await emitKeypress(setup!, { name: "o", sequence: "o" });
  expect(opened.at(-1)).toContain("/kept.htm");

  mode = "recovered";
  await emitKeypress(setup!, { name: "r", sequence: "r" });
  await settleFrame(setup!, 8);
  expect(frame().split("FIRST acquisition terms").length - 1).toBe(2);
  expect(JSON.stringify(footer)).not.toContain("Refresh outage");
  await emitKeypress(setup!, { name: "o", sequence: "o" });
  expect(opened.at(-1)).toContain("/kept.htm");
});

test("obsolete company response cannot overwrite a newer company or restore its source action", async () => {
  let pending!: (response: Response) => void;
  transport((ticker) => ticker === "SECOND"
    ? new Promise((resolve) => { pending = resolve; })
    : Response.json({ ticker, events: [event(ticker)] }));
  await mount();
  await select("SECOND");
  await select("THIRD");
  await act(async () => pending(Response.json({ ticker: "SECOND", events: [event("SECOND")] })));
  await settleFrame(setup!, 8);
  const current = frame();
  expect(current).toContain("THIRD acquisition terms");
  expect(current).not.toContain("SECOND acquisition terms");
  await emitKeypress(setup!, { name: "o", sequence: "o" });
  expect(opened.at(-1)).toContain("/THIRD/");
});

test("page keys move the selection a screen at a time and Enter opens it", async () => {
  transport((ticker) => Response.json({ ticker, events: Array.from({ length: 12 }, (_, index) => event(ticker, `f${index}`)) }));
  await mount();
  const openSelected = async () => {
    await emitKeypress(setup!, { name: "return" });
    return Number(/f(\d+)\.htm$/.exec(opened.at(-1) ?? "")?.[1]);
  };
  const end = await emitKeypress(setup!, { name: "end" }, { trackPropagation: true });
  expect(end.defaultPrevented).toBe(true);
  expect(await openSelected()).toBe(11);
  await emitKeypress(setup!, { name: "home" });
  expect(await openSelected()).toBe(0);
  await emitKeypress(setup!, { name: "pagedown" });
  const paged = await openSelected();
  expect(paged).toBeGreaterThan(1);
  await emitKeypress(setup!, { name: "pageup" });
  expect(await openSelected()).toBe(0);
  // With nothing further to select, the key is left to scroll the feed.
  const top = await emitKeypress(setup!, { name: "k" }, { trackPropagation: true });
  expect(top.defaultPrevented).toBe(false);
});
