import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { MnaDeal, MnaDealsPayload } from "../../../api-client/mna";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { Quote } from "../../../types/financials";
import { Box } from "../../../ui";
import { mnaDealCache, mnaDealsCache } from "./client";
import { MnaPane } from "./pane";

const deal = (overrides: Partial<MnaDeal>): MnaDeal => ({
  id: "acv",
  target: { name: "ACV Auctions Inc.", symbol: "ACVA", country: "US" },
  acquirer: { name: "Copart, Inc.", symbol: "CPRT", country: "US" },
  status: "pending",
  stage: "Tender offer",
  hostile: false,
  terms: { consideration: "cash", cashPerShare: 10.5, exchangeRatio: null, ratioSymbol: null, currency: "USD", cvr: false, partial: false },
  value: 1.78e9,
  valueCurrency: "USD",
  valueUsd: 1.78e9,
  announced: "2026-09-10",
  expectedClose: "2026-10-15",
  closed: null,
  headline: "Copart to buy ACV Auctions for $10.50 a share in cash",
  updatedAt: "2026-09-17T00:00:00Z",
  lastReported: "2026-09-17",
  stale: false,
  ...overrides,
});

const delayed: MnaDealsPayload = {
  deals: [
    deal({}),
    deal({
      id: "col",
      target: { name: "COL Group", symbol: null, country: "IT" },
      acquirer: { name: "Eaton", symbol: "ETN", country: "IE" },
      stage: null,
      terms: { consideration: "undisclosed", cashPerShare: null, exchangeRatio: null, ratioSymbol: null, currency: null, cvr: false, partial: false },
      value: 810e6,
      valueCurrency: "EUR",
      expectedClose: "Q1 2027",
    }),
  ],
  hasMore: false,
  nextOffset: 2,
  access: "delayed",
  delayDays: 7,
  lockedDeals: 12,
  asOf: "2026-09-27T12:00:00Z",
};

const tui = createOpenTuiTestHarness();
afterEach(() => {
  setCloudApiFetchTransport(null);
  mnaDealsCache.reset();
  mnaDealCache.reset();
});

async function mount(width = 130, height = 10) {
  mnaDealsCache.attach(new MemoryPluginPersistence());
  mnaDealCache.attach(new MemoryPluginPersistence());
  const paneId = "mna:test";
  const state = createInitialState(createTestPaneConfig("/tmp/mna-test", { paneId: "mna", instanceId: paneId }));
  const provider = createTestDataProvider({
    getQuote: async (symbol) => ({ symbol, price: 10.46, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() } as Quote),
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider as never });
  function Harness() {
    // The open deal is pane state, so the harness needs a reducer.
    const [paneState, setPaneState] = useState<AppState["paneState"]>({});
    state.paneState = paneState;
    const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
        <PaneFooterProvider>{(footer) => (
          <Box width={width} height={height} flexDirection="column">
            <Box height={height - 1}><MnaPane focused width={width} height={height - 1} paneId={paneId} paneType="mna" /></Box>
            <PaneFooterBar footer={footer} focused width={width} />
          </Box>
        )}</PaneFooterProvider>
      </TestPaneProvider>
    );
  }
  await tui.render(<Harness />, { width, height });
  for (let i = 0; i < 6; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
  return tui.frame();
}

test("a delayed list shows locked rows for the newest deals, terms, private targets and the upgrade key", async () => {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    requests.push(String(input));
    return Response.json(delayed);
  });
  const frame = await mount();
  // Listed targets first.
  expect(requests[0]).toContain("/cloud/mna/deals?status=pending&target=public");
  expect(frame).toContain("Unlock 12 newer deals");
  expect(frame).toContain("ACVA");
  expect(frame).toContain("$10.50 cash");
  // Live spread against the 10.46 quote.
  expect(frame).toContain("0.38%");
  expect(frame).toContain("Tender offer");
  expect(frame).toContain("COL Group");
  expect(frame).toContain("€810M");
  expect(frame).toContain("Q1 27");
  expect(frame).toContain("[$]upgrade");
});

test("Enter opens a deal's timeline under its two names", async () => {
  setCloudApiFetchTransport(async (input) => {
    const url = String(input);
    if (url.includes("/cloud/mna/deals/acv")) {
      return Response.json({
        deal: delayed.deals[0],
        access: "full",
        events: [
          { id: "2", date: "2026-09-17", kind: "tender", title: "Tender offer launched", source: "SC TO-T", url: "https://www.sec.gov/a" },
          { id: "1", date: "2026-09-10", kind: "announced", title: "Copart to buy ACV Auctions for $10.50 a share", source: "PR Newswire", url: null },
        ],
      });
    }
    return Response.json({ ...delayed, access: "full", delayDays: 0, lockedDeals: 0 });
  });
  await mount(130, 16);
  await act(async () => tui.setup().mockInput.pressEnter());
  for (let i = 0; i < 6; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
  const frame = tui.frame();
  expect(frame).toContain("ACV Auctions Inc. ← Copart, Inc.");
  expect(frame).toContain("Tender offer launched");
  expect(frame).toContain("SC TO-T");
  expect(frame).toContain("[o]pen source");
});
