import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { MnaDeal, MnaDealsPayload } from "../../../api-client/mna";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { Quote } from "../../../types/financials";
import { Box } from "../../../ui";
import { mnaDealCache, mnaDealsCache } from "./client";
import { MnaPane, MnaTickerTab } from "./pane";

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

/** The ticker the pane is linked to: its key, and the venue the saved ticker names. */
interface Listing { key: string; exchange: string }

async function mount(width = 130, height = 10, listing?: Listing, as: "pane" | "tab" = "pane", quote?: (symbol: string) => Quote) {
  mnaDealsCache.attach(new MemoryPluginPersistence());
  mnaDealCache.attach(new MemoryPluginPersistence());
  const paneId = "mna:test";
  const state = createInitialState(createTestPaneConfig("/tmp/mna-test", {
    paneId: "mna",
    instanceId: paneId,
    ...(listing ? { binding: { kind: "fixed" as const, symbol: listing.key } } : {}),
  }));
  if (listing) state.tickers.set(listing.key, createTestTicker(listing.key, listing.key, { exchange: listing.exchange }));
  const provider = createTestDataProvider({
    getQuote: async (symbol) => quote?.(symbol) ?? ({ symbol, price: 10.46, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() } as Quote),
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
            <Box height={height - 1}>
              {as === "tab"
                ? <MnaTickerTab focused width={width} height={height - 1} onCapture={() => {}} />
                : <MnaPane focused width={width} height={height - 1} paneId={paneId} paneType="mna" />}
            </Box>
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
  expect(frame).toContain("€810.00M");
  expect(frame).toContain("Q1 27");
  expect(frame).toContain("[$]upgrade");
  // AS OF is drawn beside the spread, but Export CSV keeps CLOSE and STAGE where an earlier export had them.
  await exportPaneTable("mna:test", "mna.csv");
  const header = takeSavedTextFile()!.text.split("\n")[0]!.split(",");
  expect(header.findIndex((name) => /^as of/i.test(name))).toBe(header.length - 1);
  expect(header.findIndex((name) => /^stage/i.test(name))).toBe(header.length - 2);
});

// The detail read "Spread 0.39%" from two trades 8.6 hours apart, beside a chart of Monday's closes, with nothing dating either.
test("Enter opens a deal's timeline under its two names, its spread at the session's close with the latest trade beside it", async () => {
  const outsideDate = { date: "2027-05-04", extendedTo: "2027-11-04", extension: "if only antitrust approvals remain", source: { form: "8-K", filed: "2026-11-04", url: "https://www.sec.gov/b" } };
  setCloudApiFetchTransport(async (input) => {
    const url = String(input);
    if (url.includes("/cloud/mna/deals/acv")) {
      return Response.json({
        deal: { ...delayed.deals[0], outsideDate },
        access: "full",
        events: [
          { id: "2", date: "2026-09-17", kind: "tender", title: "Tender offer launched", source: "SC TO-T", url: "https://www.sec.gov/a" },
          { id: "1", date: "2026-09-10", kind: "announced", title: "Copart to buy ACV Auctions for $10.50 a share", source: "PR Newswire", url: null },
        ],
      });
    }
    return Response.json({ ...delayed, access: "full", delayDays: 0, lockedDeals: 0 });
  });
  // New York's pre-market: a trade this morning, and the close of the session before.
  const session = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const premarket = (symbol: string) => ({
    symbol, price: 10.4, currency: "USD", change: 0, changePercent: 0, exchangeName: "NASDAQ", marketState: "PRE",
    lastUpdated: Date.parse("2026-11-17T09:24:49Z"), lastTradeTime: Date.parse("2026-11-17T09:24:49Z"),
    regularClose: 10.46, regularCloseSessionDate: session,
  } as Quote);
  await mount(130, 20, undefined, "pane", premarket);
  await act(async () => tui.setup().mockInput.pressEnter());
  for (let i = 0; i < 6; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
  const frame = tui.frame();
  expect(frame).toContain("ACV Auctions Inc. ← Copart, Inc.");
  // 10.50 against the 10.46 close, said to be the close; the trade since it beside it, and the leg's own print.
  expect(frame).toMatch(/Spread +0\.38% +(\$0\.04 · )?\w{3} close/);
  expect(frame).toMatch(/Latest +0\.96% +pre-market \d\d:\d\d/);
  expect(frame).toMatch(/ACVA +10\.40 +pre-market \d\d:\d\d/);
  expect(frame).toMatch(/Outside +4 May 2027 +to 4 Nov 2027 if only antitrust approvals remain · 8-K 4 Nov 2026/);
  expect(frame).toContain("Tender offer launched");
  expect(frame).toContain("SC TO-T");
  expect(frame).toContain("[o]pen source");
});

const athabasca: MnaDealsPayload = {
  ...delayed,
  deals: [
    deal({
      id: "ath",
      target: { name: "Athabasca Oil Corporation", symbol: "ATH.TO", country: "CA" },
      acquirer: { name: "Cenovus Energy Inc.", symbol: "CVE.TO", country: "CA" },
      stage: null,
      terms: { consideration: "mixed", cashPerShare: 12, exchangeRatio: 0.264, ratioSymbol: "CVE.TO", currency: "CAD", cvr: false, partial: false, election: true },
    }),
  ],
  nextOffset: 1,
  lockedDeals: 0,
};

/** The deals request the pane made for the ticker it is linked to. */
async function dealsRequest(listing: Listing, payload: MnaDealsPayload, as: "pane" | "tab" = "pane") {
  const requests: URL[] = [];
  setCloudApiFetchTransport(async (input) => {
    requests.push(new URL(String(input)));
    return Response.json(payload);
  });
  const frame = await mount(130, 10, listing, as);
  return { frame, request: requests.find((url) => url.pathname === "/cloud/mna/deals") };
}

test("a listing abroad asks for its deals by the symbol they are filed under, the target's or the buyer's", async () => {
  // ATH:TSX is stored as ATH.TO; the bare ATH is Athene on the NYSE.
  const target = await dealsRequest({ key: "ATH:TSX", exchange: "TSX" }, athabasca);
  expect(target.request?.searchParams.get("symbol")).toBe("ATH.TO");
  expect(target.frame).toContain("ATH.TO");
  expect(target.frame).not.toContain("No deals involving");
  const buyer = await dealsRequest({ key: "CVE:TSX", exchange: "TSX" }, athabasca);
  expect(buyer.request?.searchParams.get("symbol")).toBe("CVE.TO");
  expect(buyer.frame).toContain("Cenovus");
});

test("the ticker's research tab asks the same way, not by the key with its venue", async () => {
  const abroad = await dealsRequest({ key: "ATH:TSX", exchange: "TSX" }, athabasca, "tab");
  expect(abroad.request?.searchParams.get("symbol")).toBe("ATH.TO");
  expect(abroad.frame).toContain("ATH.TO");
  mnaDealsCache.reset();
  const us = await dealsRequest({ key: "ACVA", exchange: "NASDAQ" }, delayed, "tab");
  expect(us.request?.searchParams.get("symbol")).toBe("ACVA");
});

test("a US listing still asks by its bare symbol, whichever way its key spells the venue", async () => {
  for (const listing of [{ key: "ACVA", exchange: "NASDAQ" }, { key: "ACVA:XNAS", exchange: "NASDAQ" }, { key: "ACVA:NASDAQ", exchange: "" }]) {
    mnaDealsCache.reset();
    const { request } = await dealsRequest(listing, delayed);
    expect(request?.searchParams.get("symbol")).toBe("ACVA");
  }
});
