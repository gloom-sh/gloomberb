import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useReducer, type ReactNode } from "react";
import { RGBA } from "@opentui/core";
import { apiClient } from "../../../api-client";
import type { CatalystResponse } from "../../../api-client/catalysts";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { colors } from "../../../theme/colors";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { DataProvider, SecFilingDocument, SecFilingItem } from "../../../types/data-provider";
import type { AnalystResearchData, CorporateActionsData, TickerFinancials } from "../../../types/financials";
import type { GloomPluginContext } from "../../../types/plugin-context";
import type { TickerResearchTabDef } from "../../../types/plugin-contributions";
import { catalystCache } from "../catalysts/client";
import { catalystFixture, catalystPayload } from "../catalysts/test-fixture";
import { getTableWidth } from "../../../components/ui/table-layout";
import { EarningsEstimatesView, estimateColumns } from "./earnings-estimates-pane";
import { EventsDividendsView, EventsPane, EventsResearchEarnings } from "./event-views";
import { researchModule } from "./index";

const tui = createOpenTuiTestHarness();
const WIDTH = 120;
const HEIGHT = 34;

// Every view reads the listing's day: the fixture's reports and ex-dates sit around this one.
beforeAll(() => { setSystemTime(new Date("2026-11-24T15:00:00Z")); });
afterAll(() => { setSystemTime(); });

const reported = (date: string, fiscalPeriod: string, epsActual: number, epsEstimate: number) => (
  { date, dateType: "announcement" as const, fiscalPeriod, epsActual, epsEstimate, epsBasis: "gaap" as const, epsActualSource: "press-release" as const, currency: "USD" });
const paid = (exDate: string, amount: number) => ({ exDate, amount });

const ACTIONS: CorporateActionsData = {
  symbol: "TEST", currency: "USD",
  coverage: { dividends: "available", earnings: "available", splits: "available" },
  earnings: [
    { ...reported("2025-10-30", "2025-09", 1.85, 1.77), epsActualSource: undefined },
    reported("2026-01-29", "2025-12", 2.84, 2.67),
    reported("2026-04-30", "2026-03", 1.65, 1.7),
    reported("2026-07-30", "2026-06", 1.57, 1.43),
    reported("2026-10-29", "2026-09", 1.85, 1.77),
    { date: "2027-01-28", dateType: "announcement", fiscalPeriod: "2026-12", epsEstimate: 2.67, epsAnalysts: 30, dateStatus: "confirmed", currency: "USD" },
  ],
  // Nothing paid from 2020 to 2024, a split going ex in 2022: two gaps either side of the year it says.
  dividends: [paid("2019-05-10", 0.2), paid("2025-02-10", 0.25), paid("2025-08-11", 0.25), paid("2026-02-09", 0.26), paid("2026-08-10", 0.26)],
  splits: [{ date: "2022-08-31", fromFactor: 1, toFactor: 4 }],
};

const ESTIMATES: AnalystResearchData = {
  symbol: "TEST", currency: "USD", recommendations: [], ratings: [],
  earningsEstimates: [{ date: "2026-12-31", period: "current_quarter", average: 2.65, analysts: 29, growth: 0.07, currency: "USD" }],
  revenueEstimates: [{ date: "2026-12-31", period: "current_quarter", average: 138e9, analysts: 28, growth: 0.08, currency: "USD" }],
};

const event = (id: string, deadlineDate: string, title: string) => ({ ...catalystFixture, id, title, deadlineDate, datePrecision: { deadline: "day" as const } });
const catalysts = (...events: ReturnType<typeof event>[]): CatalystResponse => ({ ...catalystPayload(), events, total: events.length });

let catalystsSpy: ReturnType<typeof spyOn>;
let catalystReads: unknown[] = [];
let answerCatalysts: () => Promise<CatalystResponse> = async () => catalysts();

beforeEach(() => {
  catalystReads = [];
  answerCatalysts = async () => catalysts();
  catalystsSpy = spyOn(apiClient, "getCloudCatalysts").mockImplementation(async (query) => {
    catalystReads.push(query);
    return answerCatalysts();
  });
});
let coordinator: MarketDataCoordinator | null = null;
afterEach(() => {
  catalystsSpy.mockRestore();
  catalystCache.reset();
  coordinator?.destroy();
  coordinator = null;
  setSharedMarketDataCoordinator(null);
});

interface MountOptions {
  symbol?: string;
  /** The pane drawn, EVT's unless named; `earnings-estimates` draws EE. */
  pane?: "corporate-actions" | "earnings-estimates";
  actions?: () => Promise<CorporateActionsData>;
  estimates?: () => Promise<AnalystResearchData>;
  financials?: Partial<TickerFinancials>;
  paneState?: AppState["paneState"];
  /** The pane's settings, as a layout or `shot` gives them. */
  settings?: Record<string, unknown>;
  content?: (body: { width: number; height: number }) => ReactNode;
  /** The SEC reads an opened report's detail makes, which go through the shared market data. */
  sec?: Pick<DataProvider, "getSecFilings" | "getSecFilingDocuments" | "getSecFilingContent">;
}

async function settle(frames = 6) {
  for (let index = 0; index < frames; index++) await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
}

/** EVT on its own (or the view `content` draws) for a fixed ticker, with its pane state kept as the app keeps it. */
async function mount(options: MountOptions = {}) {
  const symbol = options.symbol ?? "TEST";
  const pane = options.pane ?? "corporate-actions";
  const paneId = `${pane}:${symbol}`;
  const config = createTestPaneConfig("/tmp/gloom-event-views-test", { instanceId: paneId, paneId: pane, binding: { kind: "fixed", symbol }, settings: options.settings });
  const initial = createInitialState(config);
  initial.focusedPaneId = paneId;
  initial.paneState = options.paneState ?? {};
  initial.tickers = new Map([[symbol, createTestTicker(symbol, "Test Inc", { exchange: "NASDAQ", currency: "USD" })]]);
  if (options.financials) {
    initial.financials = new Map([[symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [], ...options.financials } as TickerFinancials]]);
  }
  const opened: Array<[string, unknown]> = [];
  const provider = createTestDataProvider({
    getCorporateActions: options.actions ?? (async () => structuredClone(ACTIONS)),
    getAnalystResearch: options.estimates ?? (async () => structuredClone(ESTIMATES)),
    ...options.sec,
  });
  if (options.sec) {
    coordinator?.destroy();
    coordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(coordinator);
  }
  const runtime = createTestPluginRuntime({ getMarketData: () => provider, createPaneFromTemplate: (template, args) => { opened.push([template, args]); } });
  const app = { state: initial };
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    app.state = state;
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={paneId} pluginId="research" runtime={runtime} width={WIDTH} height={HEIGHT}>
        {(body) => options.content?.(body) ?? (pane === "earnings-estimates" ? <EarningsEstimatesView focused {...body} /> : <EventsPane focused {...body} />)}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: WIDTH, height: HEIGHT }); });
  await settle();
  return { app, opened };
}

const lines = () => tui.frame().split("\n");
const line = (text: string) => lines().find((row) => row.includes(text)) ?? "";
const hex = (color: string) => RGBA.fromHex(color).toInts().join(",");
const FUND = { quote: { instrumentType: "ETF", currency: "USD" } } as Partial<TickerFinancials>;

describe("EVT's Earnings view", () => {
  test("opens on what is next: the report with its consensus, the last ex-date and the next catalyst", async () => {
    answerCatalysts = async () => catalysts(event("later", "2027-06-01", "Court hearing"), event("next", "2027-03-15", "FDA decision"));
    await mount();
    expect(lines()[0]).toMatch(/^\s*Earnings\s+Dividends\s*$/);
    const figures = tui.frame();
    expect(figures).toMatch(/Next report\s+28 Jan 2027\s+in 65 days · confirmed/);
    expect(line("EPS est").trim()).toMatch(/EPS est\s+2\.67 USD\s+30 analysts$/);
    expect(figures).toMatch(/Revenue est\s+138B USD\s+28 analysts · \+8\.00% y\/y/);
    expect(figures).toMatch(/Last ex\s+10 Aug 2026\s+\$0\.26/);
    // The earliest catalyst ahead, not the first the calendar lists.
    expect(figures).toMatch(/Next catalyst\s+15 Mar 2027\s+in 111 days · FDA decision/);
    expect(catalystReads).toEqual([{ symbol: "TEST", upcoming: true, dateField: "any", limit: 20, offset: 0 }]);
  });

  test("charts each quarter's estimate beside what was reported, a beat and a miss in their colours, over the quarters' table", async () => {
    await mount();
    expect(line("● Estimate")).toMatch(/● Estimate .*● Beat .*● Miss/);
    // The next report first, then the reported quarters newest first, each with its surprise.
    const table = lines().slice(lines().findIndex((row) => /DATE\s+QUARTER/.test(row)) + 1);
    expect(table.slice(0, 6).map((row) => row.trim().slice(0, 11))).toEqual([
      "28 Jan 2027", "29 Oct 2026", "30 Jul 2026", "30 Apr 2026", "29 Jan 2026", "30 Oct 2025"]);
    expect(table[0]).toMatch(/28 Jan 2027 Dec 2026\s+2\.67\s+confirmed, 30 analysts/);
    expect(table[1]).toMatch(/29 Oct 2026 Sep 2026\s+1\.85\s+1\.77\s+\+4\.52%/);
    expect(table[3]).toMatch(/30 Apr 2026 Mar 2026\s+1\.65\s+1\.70\s+-2\.94%/);
    expect(table[5]).toMatch(/30 Oct 2025 Sep 2025\s+1\.85\s+1\.77\s+—/);
    expect(line("● Estimate")).toContain("● EPS");
    // In a terminal the bars are cell characters: a beat's in the positive colour, a miss's in the negative.
    const chartRows = tui.setup().captureSpans().lines.slice(0, lines().findIndex((row) => /DATE\s+QUARTER/.test(row)));
    const barColours = new Set(chartRows.flatMap((row) => row.spans).filter((span) => /[█▄▀▌▐]/.test(span.text)).map((span) => span.fg.toInts().join(",")));
    expect(barColours).toContain(hex(colors.positive));
    expect(barColours).toContain(hex(colors.negative));
    expect(barColours).toContain(hex(colors.textMuted));
  });

  test("a failed catalyst read is the footer's, the rest stands, and a refresh asks again", async () => {
    answerCatalysts = async () => { throw new Error("Catalyst calendar timed out"); };
    await mount();
    expect(line("└")).toContain("Catalysts unavailable: Catalyst calendar timed out");
    expect(tui.frame()).toContain("Next report");
    expect(tui.frame()).not.toContain("Next catalyst");
    answerCatalysts = async () => catalysts(event("next", "2027-03-15", "FDA decision"));
    await tui.emitKeypress({ name: "r" });
    await settle();
    expect(line("Next catalyst")).toContain("FDA decision");
    expect(tui.frame()).not.toContain("Catalysts unavailable");
    // Signed out, the Catalysts view says so: here the figure is only left out.
    catalystCache.reset();
    answerCatalysts = async () => { throw new Error("Gloom Cloud requires signup and email verification"); };
    await mount();
    expect(tui.frame()).not.toContain("Next catalyst");
    expect(tui.frame()).not.toContain("Gloom Cloud requires");
  });
});

describe("an earnings quarter's detail", () => {
  // TEST's Q2 results, filed the day it reported them, with the press release as its exhibit.
  const filing: SecFilingItem = { accessionNumber: "0000000001-26-000042", form: "8-K", filingDate: new Date("2026-07-30T00:00:00Z"),
    cik: "1", companyName: "Test Inc", primaryDocument: "results.htm", items: "2.02,9.01", primaryDocDescription: "Results of operations",
    filingUrl: "https://www.sec.gov/Archives/1/index.htm", primaryDocumentUrl: "https://www.sec.gov/Archives/1/results.htm" };
  const sec = {
    getSecFilings: async () => [filing],
    getSecFilingDocuments: async (): Promise<SecFilingDocument[]> => [
      { document: "results.htm", type: "8-K", url: filing.primaryDocumentUrl!, isPrimary: true },
      { document: "release.htm", type: "EX-99.1", description: "Press release", url: "https://www.sec.gov/Archives/1/release.htm", isPrimary: false },
    ],
    getSecFilingContent: async () => "Quarterly revenue rose to a record on services.",
  } satisfies MountOptions["sec"];
  const detailOf = (app: { state: AppState }) => app.state.paneState["corporate-actions:TEST"]?.pluginState?.research as
    { openRowId?: string | null; earningsQuarter?: string | null } | undefined;

  test("Enter opens a reported quarter as EE does, with its filing, documents and exhibit; Back returns to that quarter", async () => {
    const { app } = await mount({ sec });
    await tui.emitKeypress({ name: "down" });
    await tui.emitKeypress({ name: "down" });
    await settle();
    await tui.emitKeypress({ name: "return" });
    await settle(10);
    const detail = tui.frame();
    expect(detail).toContain("Earnings | 2026-07-30");
    expect(detail).toMatch(/Actual\s+1\.57 USD/);
    expect(detail).toMatch(/Consensus\s+1\.43 USD/);
    expect(detail).toMatch(/Surprise\s+9\.79/);
    expect(detail).toMatch(/Form\s+8-K\s+filed 2026-07-30/);
    expect(detail).toContain("0000000001-26-000042");
    expect(detail).toContain("release.htm");
    expect(detail).toContain("Quarterly revenue rose to a record on services.");
    const open = detailOf(app);
    expect(open?.openRowId).toBeTruthy();
    expect(open?.earningsQuarter).toBe(open?.openRowId);
    await tui.emitKeypress({ name: "escape", sequence: "\u001b" });
    await settle();
    expect(tui.frame()).toContain("Next report");
    expect(detailOf(app)).toMatchObject({ openRowId: null, earningsQuarter: open?.earningsQuarter });
    // The same quarter again, from where Back left the selection.
    await tui.emitKeypress({ name: "return" });
    await settle(10);
    expect(tui.frame()).toContain("Earnings | 2026-07-30");
    // A click selects another quarter's row and a second opens it, as in EE.
    await tui.emitKeypress({ name: "escape", sequence: "\u001b" });
    await settle();
    await tui.clickFrameText("30 Apr 2026");
    await settle();
    expect(tui.frame()).not.toContain("Earnings | ");
    await tui.clickFrameText("30 Apr 2026");
    await settle(10);
    expect(tui.frame()).toContain("Earnings | 2026-04-30");
  });

  test("the next report opens with its consensus, and a layout saved with a quarter open opens on it", async () => {
    const { app } = await mount({ sec });
    await tui.emitKeypress({ name: "return" });
    await settle(10);
    expect(tui.frame()).toContain("Earnings | 2027-01-28");
    expect(tui.frame()).toMatch(/Consensus\s+2\.67 USD\s+30 analysts/);
    expect(tui.frame()).toMatch(/Report date\s+2027-01-28\s+confirmed/);
    // Reopened from the saved pane state, on the open quarter.
    await mount({ sec, paneState: app.state.paneState });
    expect(tui.frame()).toContain("Earnings | 2027-01-28");
    // A row no listed quarter is drawn from (a layout saved on a dividend in the old table) opens on the quarters instead.
    await mount({ sec, paneState: { "corporate-actions:TEST": { pluginState: { research: { openRowId: "dividend:2019-05-10" } } } } });
    expect(tui.frame()).toContain("Next report");
    expect(tui.frame()).not.toContain("Earnings | ");
  });
});

describe("EE's views", () => {
  const EE_ESTIMATES: AnalystResearchData = {
    ...ESTIMATES,
    earningsEstimates: [
      { date: "2026-12-31", period: "current_quarter", average: 2.65, low: 2.5, high: 2.8, analysts: 29, growth: 0.07, currency: "USD" },
      { date: "2027-03-31", period: "next_quarter", average: 1.8, analysts: 27, growth: 0.09, currency: "USD" },
      { date: "2027-09-30", period: "current_year", average: 8.4, low: 8, high: 8.9, analysts: 40, growth: 0.1, currency: "USD" },
      { date: "2028-09-30", period: "next_year", average: 9.2, analysts: 38, growth: 0.095, currency: "USD" },
    ],
    revenueEstimates: [
      { date: "2026-12-31", period: "current_quarter", average: 138e9, analysts: 28, growth: 0.08, currency: "USD" },
      { date: "2027-09-30", period: "current_year", average: 450e9, analysts: 39, growth: 0.06, currency: "USD" },
    ],
  };
  const STATEMENTS = { quarterlyStatements: ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"]
    .map((date) => ({ date, eps: 1.9, totalRevenue: 100e9, currency: "USD" })) } as Partial<TickerFinancials>;
  const ee = (options: MountOptions = {}) => mount({ pane: "earnings-estimates", estimates: async () => structuredClone(EE_ESTIMATES), financials: STATEMENTS, ...options });

  test("Estimates: the quarters and years ahead in their own sections and columns, the trailing twelve months over them", async () => {
    await ee();
    expect(lines()[0]).toMatch(/^\s*Estimates\s+Reported\s*$/);
    expect(tui.frame()).toMatch(/Next report\s+28 Jan 2027/);
    expect(tui.frame()).toMatch(/EPS TTM\s+7\.60 USD/);
    expect(tui.frame()).toMatch(/Revenue TTM\s+400B USD\s+4 qtrs to 30 Sep 2026/);
    // EE reads no ex-dates, and no reported quarter shares the estimates' columns.
    expect(tui.frame()).not.toContain("Last ex");
    expect(tui.frame()).not.toContain("29 Oct 2026");
    expect(line("PERIOD")).toMatch(/PERIOD\s+ENDS\s+EPS USD\s+EPS LOW\s+EPS HIGH\s+EPS Y\/Y\s+REVENUE USD/);
    const table = lines().slice(lines().findIndex((row) => row.includes("PERIOD")) + 1, lines().findIndex((row) => row.includes("PERIOD")) + 7);
    expect(table.map((row) => row.trim().split(/\s{2,}/)[0])).toEqual(["Quarters (2)", "cur qtr", "next qtr", "Years (2)", "cur yr", "next yr"]);
    expect(table[1]).toMatch(/31 Dec 2026\s+2\.65\s+2\.50\s+2\.80\s+\+7\.00%\s+138\.00B/);
    // Enter opens the period it is on: the nearest quarter, its inputs for each metric.
    await tui.emitKeypress({ name: "return" });
    await settle(10);
    expect(tui.frame()).toContain("Q Est | 2026-12-31");
    expect(tui.frame()).toMatch(/Analysts\s+29/);
  });

  test("Reported is EVT's Earnings view; a layout saved with a report open, or a view setting, opens on it", async () => {
    await ee();
    await tui.clickFrameText("Reported");
    await settle(10);
    expect(line("● Estimate")).toMatch(/● Estimate .*● Beat .*● Miss/);
    expect(line("29 Oct 2026")).toMatch(/Sep 2026\s+1\.85\s+1\.77\s+\+4\.52%/);
    expect(tui.frame()).toMatch(/EPS TTM\s+7\.60 USD/);
    expect(tui.frame()).not.toContain("cur qtr");
    // Saved before EE had views: its open report opens in Reported, the view kept with the layout from then on.
    const { app } = await ee({ paneState: { "earnings-estimates:TEST": { pluginState: { research: { openRowId: "earn:2026-07-30:announcement" } } } } });
    expect(tui.frame()).toContain("Earnings | 2026-07-30");
    expect(app.state.paneState["earnings-estimates:TEST"]?.pluginState?.research).toMatchObject({ eeView: "reported" });
    await ee({ settings: { view: "reported" } });
    expect(tui.frame()).toContain("● Estimate");
  });

  test("the Estimates columns name the currency each metric shares and fit any width", () => {
    for (const units of [{}, { eps: "USD", revenue: "TWD" }]) {
      for (const width of [40, 68, 90, 120, 160]) expect(getTableWidth(estimateColumns(width, units))).toBeLessThanOrEqual(Math.max(width - 1, 40));
    }
    // An ADR's EPS in dollars beside its revenue in the home currency.
    expect(estimateColumns(160, { eps: "USD", revenue: "TWD" }).map(({ label }) => label)).toEqual([
      "PERIOD", "ENDS", "EPS USD", "EPS LOW", "EPS HIGH", "EPS Y/Y", "EPS ESTS", "REVENUE TWD", "REV LOW", "REV HIGH", "REV Y/Y", "REV ESTS"]);
    // Narrow, the counts and ranges give way before the period end, which says which quarter or year a row is.
    expect(estimateColumns(90).map(({ id }) => id)).toEqual(["period", "ends", "eps", "epsLow", "epsHigh", "epsGrowth", "revenue", "revenueGrowth"]);
  });

  test("a quarter the feed has only by its period end is listed, and opens on its own figures, never a same-day pending announcement's", async () => {
    await mount({ actions: async () => ({ symbol: "TEST", currency: "USD", dividends: [], splits: [], earnings: [
      { date: "2026-09-30", dateType: "announcement", epsEstimate: 2.2 },
      { date: "2026-09-30", dateType: "fiscal-period-end", epsActual: 2, epsEstimate: 1.8, epsBasis: "gaap", currency: "USD" },
    ] }) });
    expect(line("30 Sep 2026")).toMatch(/Sep 2026\s+2\.00\s+1\.80\s+—/);
    // Under the next quarter analysts estimate.
    await tui.emitKeypress({ name: "down" });
    await settle();
    await tui.emitKeypress({ name: "return" });
    await settle(10);
    expect(tui.frame()).toMatch(/Actual\s+2 USD/);
    expect(tui.frame()).toMatch(/Consensus\s+1\.8 USD/);
    expect(tui.frame()).not.toMatch(/Surprise\s+11\.11/);
    expect(tui.frame()).not.toMatch(/Consensus\s+2\.2/);
  });
});

describe("the next catalyst from a free preview", () => {
  const preview = (...events: ReturnType<typeof event>[]) => async (): Promise<CatalystResponse> => ({ ...catalysts(...events), total: 200,
    access: { pro: false, lockedRows: 197, previewLimit: 3, lockedUpcoming: 197 } });

  test("is its first row while the rows come earliest first, and none when they do not", async () => {
    answerCatalysts = preview(event("next", "2027-03-15", "FDA decision"), event("later", "2027-06-01", "Court hearing"));
    await mount();
    expect(line("Next catalyst")).toContain("FDA decision");
    catalystCache.reset();
    answerCatalysts = preview(event("later", "2027-06-01", "Court hearing"), event("next", "2027-03-15", "FDA decision"));
    await mount();
    expect(tui.frame()).not.toContain("Next catalyst");
    expect(tui.frame()).not.toContain("Catalysts unavailable");
  });
});

describe("EVT's Dividends view", () => {
  test("is a tab away and kept as the pane's choice: one bar and row per year, gaps collapsed and splits said", async () => {
    const { app, opened } = await mount();
    await tui.clickFrameText("Dividends");
    await settle();
    expect(app.state.paneState["corporate-actions:TEST"]?.pluginState?.research).toMatchObject({ eventsView: "dividends" });
    expect(tui.frame()).not.toContain("Next report");
    expect(line("Last ex")).toMatch(/10 Aug 2026\s+\$0\.26/);
    expect(line("2026 so far")).toMatch(/\$0\.52\s+2 payments/);
    expect(line("2025 paid")).toMatch(/\$0\.50/);
    expect(line("Paying since")).toMatch(/2019\s+3 of 8 years/);
    expect(line("● Paid")).toMatch(/● Paid .*● So far/);
    const table = lines().slice(lines().findIndex((row) => /YEAR\s+PAID/.test(row)) + 1).map((row) => row.trim().replace(/\s+/g, " "));
    expect(table.slice(0, 6)).toEqual(["2026 YTD 0.52 2 so far", "2025 0.50 2", "2023-2024 no dividend for 2 years",
      "2022 no dividend · 4-for-1 split", "2020-2021 no dividend for 2 years", "2019 0.20 1"]);
    // Each payment is DVD's.
    await tui.emitKeypress({ name: "return" });
    expect(opened).toEqual([["dividend-yield-pane", expect.objectContaining({ symbol: "TEST", symbols: ["TEST"] })]]);
    // Reopened, the pane is on the view it was left on.
    await mount({ paneState: app.state.paneState });
    expect(tui.frame()).toContain("Paying since");
  });

  test("a fund opens on its distributions, its strip kept with Earnings not to be picked, and no catalyst read", async () => {
    await mount({ financials: FUND });
    expect(lines()[0]).toMatch(/^\s*Earnings\s+Dividends\s*$/);
    expect(tui.frame()).toContain("Paying since");
    await tui.clickFrameText("Earnings");
    await settle();
    expect(tui.frame()).toContain("Paying since");
    expect(tui.frame()).not.toContain("Next report");
    expect(catalystReads).toEqual([]);
  });

  test.each(["EVT", "DES Events"])("%s routes a named ETF to its distributions when financials are unavailable", async (view) => {
    let actionReads = 0;
    const { app } = await mount({
      actions: async () => {
        actionReads++;
        return { ...structuredClone(ACTIONS), name: "Test Index ETF", dividends: [], coverage: { ...ACTIONS.coverage, dividends: "unavailable" } };
      },
      content: view === "DES Events" ? (body) => <EventsResearchEarnings focused {...body} onCapture={() => {}} /> : undefined,
    });
    expect(app.state.financials.get("TEST")).toBeUndefined();
    expect(tui.frame()).toMatch(/2022\s+4-for-1 split · Distribution history incomplete/);
    expect(tui.frame()).not.toMatch(/\bEPS\b|Next report/);
    expect(actionReads).toBe(1);
  });

  test("shows a fund's split after its last recorded payout without assuming no dividend", async () => {
    await mount({ actions: async () => ({ ...ACTIONS, name: "Test Index ETF",
      dividends: [paid("2021-05-10", 0.25)], coverage: { ...ACTIONS.coverage, dividends: "unavailable" } }) });
    expect(tui.frame()).toMatch(/^\s*2022\s+4-for-1 split · Distribution history incomplete/m);
    expect(tui.frame()).toMatch(/^\s*2021\s+0\.25\s+1\b/m);
    expect(line("Paying since")).toMatch(/2021\s+1 of 1\b/);
  });
});

describe("the strip stays", () => {
  const none = async (): Promise<AnalystResearchData> => null as never;
  const cases: Array<[string, Pick<MountOptions, "actions" | "estimates">, string]> = [
    ["loading", { actions: () => new Promise<never>(() => {}), estimates: () => new Promise<never>(() => {}) }, "Loading"],
    ["failed", { actions: async () => { throw new Error("Corporate actions source timed out"); }, estimates: none }, "Corporate actions source timed out"],
    ["empty", { actions: async () => ({ symbol: "TEST", currency: "USD", dividends: [], splits: [], earnings: [] }), estimates: none }, "No dividends, splits, or reported earnings for TEST"],
  ];
  test.each(cases)("through a %s answer, on both views", async (_case, sources, says) => {
    await mount(sources);
    expect(lines()[0]).toMatch(/^\s*Earnings\s+Dividends\s*$/);
    expect(tui.frame()).toContain(says);
    await tui.clickFrameText("Dividends");
    await settle();
    expect(lines()[0]).toMatch(/^\s*Earnings\s+Dividends\s*$/);
  });
});

describe("what saved layouts, --tab and shortcuts name", () => {
  const registered = () => {
    const tabs: TickerResearchTabDef[] = [];
    researchModule.setup?.({ registerTickerResearchTab: (tab: TickerResearchTabDef) => { tabs.push(tab); } } as unknown as GloomPluginContext);
    return tabs;
  };

  test("the research tab corporate-actions is the Earnings view, for funds too; event-dividends is the Dividends view", () => {
    const tabs = registered();
    expect(tabs.find((tab) => tab.id === "corporate-actions")).toMatchObject({ name: "Earnings", instruments: ["equity", "fund"], component: EventsResearchEarnings });
    expect(tabs.find((tab) => tab.id === "event-dividends")).toMatchObject({ name: "Dividends", instruments: ["equity"], component: EventsDividendsView });
  });

  test("EVT and EE open the panes their layouts saved, each its own view", () => {
    const template = (shortcut: string) => researchModule.paneTemplates?.find((entry) => (
      typeof entry.shortcut === "string" ? entry.shortcut : entry.shortcut?.prefix) === shortcut);
    expect(template("EVT")).toMatchObject({ id: "corporate-actions-pane", paneId: "corporate-actions" });
    expect(template("EE")).toMatchObject({ id: "earnings-estimates-pane", paneId: "earnings-estimates" });
    expect(researchModule.panes?.find((pane) => pane.id === "corporate-actions")?.component).toBe(EventsPane);
    expect(researchModule.panes?.find((pane) => pane.id === "earnings-estimates")?.component).toBe(EarningsEstimatesView);
  });

  test("in Ticker Research, a fund's Events tab is its Dividends view", async () => {
    await mount({ financials: FUND, content: (body) => <EventsResearchEarnings focused {...body} onCapture={() => {}} /> });
    expect(tui.frame()).toContain("Paying since");
    expect(tui.frame()).not.toContain("Next report");
    await mount({ content: (body) => <EventsResearchEarnings focused {...body} onCapture={() => {}} /> });
    expect(tui.frame()).toContain("Next report");
  });

  test.each([["AFK", EventsResearchEarnings], ["IQQ5:XETRA", EventsDividendsView]] as const)(
    "%s renders distributions without requesting analyst research", async (symbol, View) => {
      let estimates = 0;
      await mount({ symbol, financials: FUND, content: (body) => <View {...body} focused onCapture={() => {}} />,
        estimates: async () => { estimates++; throw new Error("UPSTREAM_ERROR"); } });
      expect(tui.frame()).toContain("Paying since");
      expect(tui.frame()).not.toContain("UPSTREAM_ERROR");
      expect(estimates).toBe(0);
    },
  );
});
