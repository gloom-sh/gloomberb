import { describe, expect, test } from "bun:test";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import {
  assessPaneScreenshot,
  buildDesktopShotPayload,
  chartSeriesEvidenceWithinRange,
  chartEvidenceMismatchesFor,
  createDesktopShotBridge,
  filledKeyValueCount,
  isPaneScreenshotUsable,
  missingActiveTabSelections,
  resolveDesktopShotApiProxy,
  shotDataEvidenceFor,
  shotExpectedText,
  shotSemanticRowCount,
  shotUnavailableSymbols,
  stripDesktopShotCredentials,
  type PaneScreenshotExpectedChartEvidence,
  type PaneScreenshotExpectedSelection,
} from "./screenshot";
import { paneEvidenceMismatches } from "./screenshot-evidence";
import { realizedVolSemanticEvidence } from "../../plugins/builtin/realized-vol/evidence";
import { coneChartSeries, realizedChartSeries } from "../../plugins/builtin/realized-vol/chart-model";
import { collectShotSymbols } from "./data";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import { buildCustomChartPreset } from "../../plugins/builtin/chart-composer/presets";
import { CHART_COMPOSER_PANE_ID, createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import { createSnapshotDataProvider } from "../../market-data/snapshot-provider";
import { volatilitySemanticEvidence } from "../../plugins/builtin/volatility/evidence";
import { buildVolatilityData } from "../../plugins/builtin/volatility/model";
import { scenarioSemanticEvidence } from "../../plugins/builtin/options-scenario/evidence";
import { buildScenario, parseLegs } from "../../plugins/builtin/options-scenario/model";
import { optionsScenarioHeadless } from "../../plugins/builtin/options-scenario/headless";
import { calculatorSemanticEvidence } from "../../plugins/builtin/options-calculator/evidence";
import { draftFromCalculatorInputs } from "../../plugins/builtin/options-calculator/inputs";
import { optionsCalculatorHeadless } from "../../plugins/builtin/options-calculator/headless";
import { valueOption, solveImpliedVolatility } from "../../plugins/builtin/shared/volatility";
import { loadSeasonalityHistory } from "../../plugins/builtin/seasonality/client";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { MARGIN_PORTFOLIO, MARGIN_TICKERS, marginQuotes } from "../../test-support/margin-account";
import type { FinancialStatement, PricePoint, TickerFinancials } from "../../types/financials";
import { loadPeriodEndHistory } from "../../plugins/builtin/ticker-detail/financials/period-end-history";
import {
  RATIO_TABS,
  formatRatioValue,
  periodEndClose,
  ratioTableForFinancials,
} from "../../plugins/builtin/ticker-detail/financials/ratios";

test("calculator screenshots freeze percent inputs without market requests, including an inactive cash schedule", async () => {
  const request = { pane: { id: "options-calculator" }, capability: { id: "options-calculator-pane", options: optionsCalculatorHeadless.options },
    instance: { instanceId: "ovme:test", paneId: "options-calculator", binding: { kind: "none" }, settings: {} },
    options: { model: "european", symbol: "AAPL", spot: "120", strike: "100", volatility: "20", rate: "5", dividends: "10:1" },
  } as unknown as ResolvedPaneFunction;
  const shot = await buildDesktopShotPayload(request, {
    config: createDefaultConfig("/tmp/calculator-shot-test"), store: { loadTicker: async () => { throw new Error("Unexpected ticker request"); } },
    dataProvider: { id: "offline", getTickerFinancials: async () => { throw new Error("Unexpected financials request"); } },
  } as unknown as MarketContext, "", {}, 800, 600, null, 1, null);
  expect(shot.config.layout.instances[0]!.settings.calculatorSnapshot).toMatchObject({
    draft: { symbol: "AAPL", spot: 120, volatility: .2, rate: .05, pricingModel: "european", dividends: [{ days: 10, amount: 1 }] }, surface: null,
  });
  expect(shot.financials).toEqual([]);
  expect(shot.optionsChains).toEqual([]);
});

test("calculator screenshot evidence must match the requested inputs, not just a self-consistent default price", () => {
  const options = { model: "european", symbol: "AAPL", spot: "120", volatility: "30", days: "365", marketPrice: "28" };
  const draft = draftFromCalculatorInputs(options);
  const request = { ...resolved("options-calculator-pane", options), pane: { id: "options-calculator" } } as ResolvedPaneFunction;
  const source = payload([]);
  source.config = { layout: { instances: [{ instanceId: source.paneId, settings: { calculatorSnapshot: { draft, surface: null } } }] } } as unknown as typeof source.config;
  const project = (inputs = draft) => calculatorSemanticEvidence({ draft: inputs, valuation: valueOption(inputs),
    implied: solveImpliedVolatility(inputs, inputs.marketPrice), loading: false, surface: null });
  const evidence = project();
  const nodes = (metadata: unknown = evidence) => [{ id: "calculator-data", role: "chart-data", actions: [], metadata }] as RemoteUiNodeSnapshot[];
  const visibleKeyValues = ["Model", "Implied IV", "Delta", "Gamma", "Theta", "Vega", "Rho"].map((label) => ({ label, text: `${label} 1` }));
  const mismatches = (req: ResolvedPaneFunction, shot: DesktopPaneShotPayload, semanticUi: RemoteUiNodeSnapshot[], visible = visibleKeyValues) => (
    paneEvidenceMismatches(req, shot, { semanticUi, visibleKeyValues: visible }));
  expect(shotDataEvidenceFor(request, source, nodes())).toEqual(evidence);
  expect(shotSemanticRowCount(request, source, nodes())).toBe(7);
  expect(shotUnavailableSymbols(request, source, nodes())).toEqual([]);
  expect(mismatches(request, source, nodes())).toEqual([]);
  expect(mismatches({ ...request, options: { ...options, model: "american", volSource: "surface" } }, source, nodes()))
    .toEqual(["option calculator snapshot does not match requested inputs"]);
  expect(mismatches(request, source, nodes(project({ ...draft, spot: 100 })))).toEqual(["rendered option calculator inputs do not match"]);
  expect(mismatches(request, { ...source, config: {} as typeof source.config }, nodes())).toHaveLength(1);
  expect(shotDataEvidenceFor(request, source, nodes({ ...evidence, complete: true, loading: true }))).toBeNull();
  expect(shotSemanticRowCount(request, source, [])).toBe(0);
  expect(shotUnavailableSymbols(request, source, [])).toEqual(["AAPL"]);
  expect(mismatches(request, source, nodes(), visibleKeyValues.slice(0, 5)))
    .toEqual(["option calculator metrics are clipped or missing: Vega, Rho"]);
});

// Regression: an overview without fundamentals reported its "-" grid as rows.
test("counts only labeled values that hold data", () => {
  const row = (label: string, value: string) => ({ label, text: `${label} ${value}` });
  expect(filledKeyValueCount([row("P/E", "-"), row("Beta", "—"), row("Yield", "N/A"), row("EPS", "")])).toBe(0);
  expect(filledKeyValueCount([row("P/E", "-12.5"), row("Sector", "Technology"), row("Beta", "-")])).toBe(2);
});

test("typed option scenario screenshot freezes report inputs without an unrelated market request", async () => {
  const request = { pane: { id: "options-scenario" }, headless: optionsScenarioHeadless,
    capability: { id: "options-scenario-pane", options: optionsScenarioHeadless.options },
    instance: { instanceId: "osa:test", paneId: "options-scenario", binding: { kind: "fixed", symbol: "AAPL" }, settings: {} },
    createOptions: { symbol: "AAPL" }, options: { legs: "call,100,2026-12-18,1,5,25", spot: "100", rate: "4",
      dividendYield: "1", currency: "USD", asOf: "2026-09-22", date: "2026-10-22", volShift: "3", spotRange: "30" },
  } as unknown as ResolvedPaneFunction;
  const shot = await buildDesktopShotPayload(request, {
    config: createDefaultConfig("/tmp/option-scenario-shot-test"), store: { loadTicker: async () => null },
    dataProvider: { id: "unavailable", getTickerFinancials: async () => { throw new Error("Unexpected financials request"); } },
  } as unknown as MarketContext, "AAPL", {}, 800, 600, null, 1, null);
  const settings = shot.config.layout.instances[0]!.settings;
  expect(settings.seedPosition).toMatchObject({ symbol: "AAPL", spot: 100, rate: .04, dividendYield: .01 });
  expect(settings.scenarioSnapshot).toMatchObject({ position: settings.seedPosition,
    controls: { date: Date.UTC(2026, 9, 22), volShift: .03, spotRange: .3 } });
  expect(shot.financials[0]![1].quote).toMatchObject({ price: 100, providerId: "user-input", dataSource: "snapshot" });
});

test("option scenario screenshots require the active numeric model and consumed strategy inputs", () => {
  const scenario = buildScenario({ symbol: "AAPL", currency: "USD", spot: 100, rate: .04, dividendYield: .01,
    asOf: Date.UTC(2026, 8, 22), legs: parseLegs("put,100,2026-12-18,1,5,25") });
  const request = { ...resolved("options-scenario-pane", { tab: "payoff" }), pane: { id: "options-scenario" },
    createOptions: { symbol: "AAPL:NASDAQ" } } as ResolvedPaneFunction;
  const source = payload([["AAPL", { quote: { price: 100 } }]]);
  source.config = { layout: { instances: [{ instanceId: source.paneId, settings: { scenarioSnapshot: scenario } }] } } as unknown as typeof source.config;
  const evidence = scenarioSemanticEvidence({ scenario, view: "payoff", loading: false });
  const nodes = (metadata: unknown = evidence) => [{ id: "scenario-data", role: "chart-data", actions: [], metadata }] as RemoteUiNodeSnapshot[];
  expect(shotSemanticRowCount(request, source, nodes())).toBe(scenario.payoff.length * 2);
  expect(shotUnavailableSymbols(request, source, nodes())).toEqual([]);
  expect(shotDataEvidenceFor(request, source, nodes())).toEqual(evidence);
  expect(paneEvidenceMismatches(request, source, { semanticUi: nodes() })).toEqual([]);
  expect(paneEvidenceMismatches({ ...request, options: { tab: "grid" } }, source, { semanticUi: nodes() })).toHaveLength(1);
  const changed = buildScenario({ ...scenario.position, legs: scenario.position.legs.map((leg) => ({ ...leg, quantity: -1 })) });
  expect(paneEvidenceMismatches(request, source, {
    semanticUi: nodes(scenarioSemanticEvidence({ scenario: changed, view: "payoff", loading: false })),
  })).toHaveLength(1);
  expect(shotDataEvidenceFor(request, source, [])).toBeNull();
  expect(shotSemanticRowCount(request, source, [])).toBe(0);
  expect(shotUnavailableSymbols(request, source, nodes({ ...evidence, loading: true, complete: false }))).toEqual(["AAPL"]);
});

test("volatility history screenshot readiness requires dated plotted values and the requested view", () => {
  const request = { ...resolved("volatility-term-structure-pane", {}), pane: { id: "volatility-term-structure" } } as ResolvedPaneFunction;
  const source = payload([]);
  source.config = { layout: { instances: [{ instanceId: source.paneId, settings: { initialTab: "history" } }] } } as unknown as typeof source.config;
  const metadata = volatilitySemanticEvidence({ data: buildVolatilityData({ fred: {
    VIXCLS: { info: null, observations: [{ date: "2026-09-21", value: 20 }] },
    VXVCLS: { info: null, observations: [{ date: "2026-09-21", value: 24 }] },
  } }), phase: "partial", loaded: 22, total: 22, stale: false, errors: [] }, "history", null, false);
  const nodes = [{ id: "volatility-data", role: "chart-data", actions: [], metadata: { ...metadata } }] as RemoteUiNodeSnapshot[];
  expect(shotSemanticRowCount(request, source, nodes)).toBe(3);
  expect(shotUnavailableSymbols(request, source, nodes)).toEqual([]);
  expect(shotDataEvidenceFor(request, source, nodes)).toEqual(metadata);
  expect(paneEvidenceMismatches(request, source, { semanticUi: nodes })).toEqual([]);
  source.config.layout.instances[0]!.settings = { initialTab: "board" };
  expect(paneEvidenceMismatches(request, source, { semanticUi: nodes })).toEqual(["rendered volatility index view does not match"]);
  expect(shotSemanticRowCount(request, source, [])).toBe(0);
  expect(shotDataEvidenceFor(request, source, [])).toBeNull();
  expect(paneEvidenceMismatches(request, source, { semanticUi: [] })).toHaveLength(1);
});

describe("realized volatility screenshot history", () => {
  const request = {
    pane: { id: "realized-vol" }, capability: { id: "realized-vol-graph-pane", options: [] },
    instance: { instanceId: "hvg:test", paneId: "realized-vol", binding: { kind: "fixed", symbol: "AAPL" }, settings: { lookbackYears: 1 } },
    createOptions: { symbol: "AAPL" }, options: {},
  } as unknown as ResolvedPaneFunction;
  const weekly = [{ date: new Date("2026-09-14"), close: 90 }];
  const financials = { quote: { symbol: "AAPL", listingExchangeName: "NASDAQ" },
    annualStatements: [], quarterlyStatements: [], priceHistory: weekly };
  const capture = (provider: object, pane = request) => buildDesktopShotPayload(pane, {
    config: createDefaultConfig("/tmp/realized-vol-shot-test"),
    store: { loadTicker: async () => null },
    dataProvider: { getTickerFinancials: async () => financials, ...provider },
  } as unknown as MarketContext, "AAPL", {}, 800, 600, null, 1, null);

  test("replaces a weekly financial snapshot with daily OHLC and preserves warmup", async () => {
    const daily = Array.from({ length: 800 }, (_, index) => ({
      date: new Date(Date.UTC(2023, 0, index + 1)), open: 100, high: 102, low: 99, close: 101,
    }));
    const calls: unknown[][] = [];
    const shot = await capture({
      async getPriceHistoryForResolution(...args: unknown[]) { calls.push(args); return daily; },
      async getPriceHistory() { throw new Error("Range-only history must not supply daily volatility"); },
    });
    expect(calls).toEqual([["AAPL", "NASDAQ", "5Y", "1d", {
      brokerId: undefined, brokerInstanceId: undefined, instrument: null,
    }]]);
    expect(shot.financials[0]![1].priceHistory).toEqual(daily);
    const captured = createSnapshotDataProvider(shot, {} as MarketContext["dataProvider"]);
    expect(await captured.getPriceHistoryForResolution!("AAPL", "NASDAQ", "5Y", "1d")).toEqual(daily);
  });

  test("does not substitute weekly prices when daily history is empty or fails", async () => {
    const empty = await capture({ getPriceHistoryForResolution: async () => [] });
    expect(empty.financials[0]![1].priceHistory).toEqual([]);
    await expect(capture({ getPriceHistoryForResolution: async () => { throw new Error("Daily source unavailable"); } }))
      .rejects.toThrow("Daily source unavailable");
    await expect(capture({})).rejects.toThrow(/daily history resolution/);
  });

  test("captures daily history for options monitor HV30 instead of reusing weekly financials", async () => {
    const daily = Array.from({ length: 252 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 9, index + 1)), close: 100 + index / 10,
    }));
    const calls: unknown[][] = [];
    const options = { ...request, pane: { ...request.pane, id: "options" },
      instance: { ...request.instance, paneId: "options" } };
    const shot = await capture({
      async getPriceHistoryForResolution(...args: unknown[]) { calls.push(args); return daily; },
      async getPriceHistory() { throw new Error("Weekly history cannot supply HV30"); },
    }, options);
    expect(calls).toEqual([["AAPL", "NASDAQ", "1Y", "1d", {
      brokerId: undefined, brokerInstanceId: undefined, instrument: null,
    }]]);
    const captured = createSnapshotDataProvider(shot, {} as MarketContext["dataProvider"]);
    expect(await captured.getPriceHistoryForResolution!("AAPL", "NASDAQ", "1Y", "1d")).toEqual(daily);
  });
});

describe("seasonality screenshot history", () => {
  const request = {
    pane: { id: "seasonality" }, capability: { id: "seasonality-pane", options: [] },
    instance: { instanceId: "seas:test", paneId: "seasonality", binding: { kind: "fixed", symbol: "SPY" }, settings: {} },
    createOptions: { symbol: "SPY" }, options: {},
  } as unknown as ResolvedPaneFunction;
  // Monday-stamped weeks: none of these closes is a month-end close.
  const weekly = [{ date: new Date("2026-08-31"), close: 770 }, { date: new Date("2026-09-28"), close: 769 }];
  const monthly = [{ date: new Date("2026-08-01"), close: 760 }, { date: new Date("2026-09-01"), close: 765 },
    { date: new Date("2026-10-01"), close: 772 }];
  const capture = (history: (resolution: string) => PricePoint[]) => buildDesktopShotPayload(request, {
    config: createDefaultConfig("/tmp/seasonality-shot-test"), store: { loadTicker: async () => null },
    dataProvider: createTestDataProvider({ getTickerFinancials: async () => createTestFinancials(),
      getPriceHistoryForResolution: async (_symbol, _exchange, _range, resolution) => history(resolution) }),
  } as unknown as MarketContext, "SPY", {}, 800, 600, null, 1, null);

  test("captures the pane's monthly closes, tagged 1mo, instead of the weekly seed", async () => {
    const requested: string[] = [];
    const shot = await capture((resolution) => { requested.push(resolution); return resolution === "1mo" ? monthly : weekly; });
    expect(requested).toEqual(["1mo"]);
    expect(shot.financials[0]![1]).toMatchObject({ priceHistory: monthly, priceHistoryResolution: "1mo" });
    // The page answers the pane's own request from the capture, never from live data.
    const page = createSnapshotDataProvider(JSON.parse(JSON.stringify(shot)), createTestDataProvider());
    const replayed = await loadSeasonalityHistory({ instrument: { symbol: "SPY" } }, page);
    expect(replayed.history.map((point) => point.close)).toEqual([760, 765, 772]);
  });

  test("fails instead of drawing another cadence when monthly history is missing", async () => {
    await expect(capture((resolution) => resolution === "1mo" ? [] : weekly)).rejects.toThrow(/^SPY: /);
  });
});

test("correlation screenshots capture daily closes where the range preset is weekly", async () => {
  const request = {
    pane: { id: "correlation" }, capability: { id: "return-correlation", options: [] },
    instance: { instanceId: "corr:test", paneId: "correlation", binding: { kind: "none" }, settings: { rangePreset: "5Y" } },
    createOptions: { symbols: ["SPY", "QQQ"] }, options: { rangePreset: "5Y" },
  } as unknown as ResolvedPaneFunction;
  const daily = [{ date: new Date("2026-09-30"), close: 100 }, { date: new Date("2026-10-01"), close: 101 }];
  const requested: unknown[][] = [];
  const shot = await buildDesktopShotPayload(request, {
    config: createDefaultConfig("/tmp/correlation-shot-test"), store: { loadTicker: async () => null },
    dataProvider: createTestDataProvider({ getTickerFinancials: async () => createTestFinancials(),
      getPriceHistory: async () => { throw new Error("A 5Y range capture is weekly"); },
      getPriceHistoryForResolution: async (symbol, _exchange, range, resolution) => { requested.push([symbol, range, resolution]); return daily; } }),
  } as unknown as MarketContext, "SPY,QQQ", {}, 800, 600, null, 1, null);
  expect(requested).toEqual([["SPY", "5Y", "1d"], ["QQQ", "5Y", "1d"]]);
  expect(shot.financials.map(([, data]) => [data.priceHistory, data.priceHistoryResolution])).toEqual([[daily, "1d"], [daily, "1d"]]);
});

describe("financial analysis ratio screenshots", () => {
  // Every line any ratio tab reads, so a correct table has a number in each cell.
  const fiscal = (date: string): FinancialStatement => ({
    date, currency: "USD", totalRevenue: 400, costOfRevenue: 160, grossProfit: 240, operatingIncome: 120, pretaxIncome: 110, taxProvision: 22,
    netIncome: 88, eps: 4.4, ordinarySharesNumber: 20, ebitda: 150, interestExpense: 5, operatingCashFlow: 130,
    capitalExpenditure: -30, freeCashFlow: 100, totalAssets: 900, currentAssets: 300, currentLiabilities: 150, inventory: 40,
    accountsReceivable: 60, accountsPayable: 30, totalDebt: 200, cashCashEquivalentsAndShortTermInvestments: 120, totalEquity: 500,
  });
  const statements = {
    quote: createTestQuote({ symbol: "MSFT", currency: "USD" }),
    annualStatements: ["2021-06-30", "2022-06-30", "2023-06-30", "2024-06-30", "2025-06-30", "2026-06-30"].map(fiscal),
    quarterlyStatements: ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"].map(fiscal),
  };
  // The pane's columns: five years, or six quarters, back from June 2026.
  const OLDEST = { annual: "2022-06-30", quarterly: "2025-03-31" } as const;
  const DAY_MS = 86_400_000;
  const RANGE_DAYS: Record<string, number> = { "6M": 183, "1Y": 366, "5Y": 1_827, ALL: 20_000 };
  /** Weekday closes, or Monday-stamped weeks, over a range ending `end`. */
  const bars = (range: string, resolution: string, end = Date.now()): PricePoint[] => {
    const points: PricePoint[] = [];
    for (let time = end - RANGE_DAYS[range]! * DAY_MS; time <= end; time += DAY_MS) {
      const date = new Date(Math.floor(time / DAY_MS) * DAY_MS);
      if (resolution === "1d" ? date.getUTCDay() % 6 !== 0 : date.getUTCDay() === 1) {
        points.push({ date, close: 100 + (Math.floor(time / DAY_MS) % 97) });
      }
    }
    return points;
  };
  const request = (statement: string, period: string) => ({
    token: "FA", pane: { id: "financial-analysis" },
    capability: { id: "financial-statements", options: [], screenshotReadiness: "ready" },
    instance: { instanceId: "fa:test", paneId: "financial-analysis", binding: { kind: "fixed", symbol: "MSFT" }, settings: {} },
    createOptions: { symbol: "MSFT" }, options: { statement, period },
  }) as unknown as ResolvedPaneFunction;
  const capture = (period: string, history: (range: string, resolution: string) => PricePoint[]) => buildDesktopShotPayload(
    request("valuation", period), {
      config: createDefaultConfig("/tmp/fa-shot-test"), store: { loadTicker: async () => null },
      dataProvider: createTestDataProvider({ getTickerFinancials: async () => createTestFinancials(statements),
        getPriceHistoryForResolution: async (_symbol, _exchange, range, resolution) => history(range, resolution) }),
    } as unknown as MarketContext, "MSFT", {}, 800, 600, null, 1, null,
  );

  test.each(["annual", "quarterly"] as const)("valuation captures daily closes back to the oldest %s period end, tagged 1d", async (period) => {
    const requested: string[] = [];
    const shot = await capture(period, (range, resolution) => { requested.push(resolution); return bars(range, resolution); });
    const [, captured] = shot.financials[0]!;
    expect(requested).toEqual(["1d"]);
    expect(captured.priceHistoryResolution).toBe("1d");
    const oldestClose = periodEndClose(captured.priceHistory, OLDEST[period]);
    expect(oldestClose).toBeNumber();
    // The page answers the pane's own request from the capture, never from live data.
    const page = createSnapshotDataProvider(JSON.parse(JSON.stringify(shot)), createTestDataProvider());
    const replayed = await loadPeriodEndHistory(page, "MSFT", "", OLDEST[period]);
    expect(periodEndClose(replayed, OLDEST[period])).toBe(oldestClose!);
  });

  test("valuation fails instead of drawing weekly bars when daily closes are missing, errored or stale", async () => {
    await expect(capture("annual", (range, resolution) => resolution === "1d" ? [] : bars(range, resolution)))
      .rejects.toThrow(/^MSFT: daily price history is unavailable/);
    await expect(capture("annual", (range, resolution) => {
      if (resolution === "1d") throw new Error("Source unavailable");
      return bars(range, resolution);
    })).rejects.toThrow(/^MSFT: Source unavailable/);
    // A source that answers the daily request with weekly bars.
    await expect(capture("annual", (range) => bars(range, "1wk"))).rejects.toThrow(/^MSFT: Daily closes are unavailable/);
    // Closes that stop more than a week before the June 2026 period end.
    await expect(capture("quarterly", (range, resolution) => bars(range, resolution, Date.parse("2026-06-01"))))
      .rejects.toThrow(/^MSFT: daily price history is stale/);
  });

  /** The pane's collapsed table drawn from `history`, as the page renders it. */
  const assess = (statement: string, financials: TickerFinancials, drawnHistory: PricePoint[] | null) => {
    const tab = RATIO_TABS.find(({ key }) => key === statement)!;
    const table = ratioTableForFinancials(financials, tab, "annual", drawnHistory);
    const columns = table.periods.map(({ statement: { date } }, index) => ({ id: `statement:${date}:${index}`, label: date.slice(0, 4) }));
    const rows = table.rows.flatMap((row, rowIndex) => row.kind === "ratio" ? [{
      tableIndex: 0, rowIndex, key: row.id, selected: rowIndex === 0,
      cells: [{ columnId: "metric", columnLabel: "Ratio", text: row.label }, ...columns.map((column, index) => ({
        columnId: column.id, columnLabel: column.label, text: formatRatioValue(row.def.format, table.cells.get(row.id)![index]!.value),
      }))],
    }] : []);
    const render: DesktopPaneShotRenderResult = {
      visibleText: ["FA MSFT Statement Income Cash Flow Balance Sheet Ratios Ratio", tab.name, "USD · as of 2026-06-30 Annual Quarterly RATIO",
        ...rows.flatMap(({ cells }) => cells.map(({ text }) => text))].join(" "),
      rows, truncated: false, truncationReasons: [], loadingStateDetected: false, errorStateDetected: false, errorStateMarkers: [],
      emptyStateDetected: false, emptyStateMarkers: [], visibleKeyValues: [],
      semanticUi: [{ id: "query", role: "query-bar", actions: [], metadata: { selections: [
        { id: "statement", value: "ratios", label: "Ratios" }, { id: "ratio", value: tab.key, label: tab.name },
        { id: "view", value: "annual", label: "Annual" }] } }],
    };
    return assessPaneScreenshot(request(statement, "annual"), { financials: [["MSFT", financials]] } as unknown as DesktopPaneShotPayload,
      render, "MSFT", "/tmp/fa-shot-test.png");
  };
  const daily = bars("5Y", "1d");
  const captured = createTestFinancials({ ...statements, priceHistory: daily, priceHistoryResolution: "1d" });

  test.each(RATIO_TABS.map(({ key }) => key))("%s: a correct shot is usable", (statement) => {
    const shot = assess(statement, captured, statement === "valuation" ? daily : null);
    expect(shot.render.missingExpectedText).toEqual([]);
    expect(shot.unusableReason).toBeNull();
    expect(shot.usable).toBe(true);
    expect(shot.dataEvidence).toMatchObject({ kind: "financial-ratios", statement, latest: { date: "2026-06-30" } });
  });

  test.each(RATIO_TABS.map(({ key }) => key))("%s: a shot whose cells all read not reported is unusable", (statement) => {
    const bare = createTestFinancials({ quote: statements.quote,
      annualStatements: statements.annualStatements.map(({ date }) => ({ date, currency: "USD", totalRevenue: 400 })),
      priceHistory: daily, priceHistoryResolution: "1d" });
    const shot = assess(statement, bare, statement === "valuation" ? daily : null);
    expect(shot.usable).toBe(false);
    expect(shot.unusableReason).toMatch(/unreported/);
  });

  test("a valuation shot that reads no price is unusable, whether the capture or the page lost the closes", () => {
    // The weekly seed, untagged: the page rejects it and every cell reads "no price".
    const seeded = assess("valuation", createTestFinancials({ ...statements, priceHistory: bars("ALL", "1wk") }), null);
    expect(seeded.usable).toBe(false);
    expect(seeded.unusableReason).toMatch(/no period-end close/);
    // A daily capture the page did not draw from.
    const undrawn = assess("valuation", captured, null);
    expect(undrawn.usable).toBe(false);
    expect(undrawn.render.chartEvidenceMismatches[0]).toMatch(/^Valuation P\/E 2026 reads "no price"/);
  });
});

describe("volatility surface screenshot evidence", () => {
  const request = { ...resolved("vol-surface-pane", { tab: "surface", axis: "spot", tenors: "listed", ivSource: "recomputed", priceSide: "mid" }),
    pane: { id: "vol-surface" }, capability: { id: "vol-surface-pane", screenshotReadiness: "live-dom" } } as ResolvedPaneFunction;
  const source = payload([["AAPL", { quote: { price: 100 } }]]);
  const metadata = {
    kind: "volatility-surface", version: 1, symbol: "AAPL", view: "surface", renderer: "bitmap", axis: "forward", tenors: "listed",
    ivSource: "recomputed", priceSide: "mid", spot: 100, spotAsOf: "2026-09-22T14:00:00Z", loading: false, complete: true,
    requestedExpiries: 2, loadedExpiries: 2, failedExpiries: 0, sourcePointCount: 4, plottedValueCount: 4, validQuadCount: 1,
    selectedExpiration: 1_800_000_000, overlaySmiles: false, failures: [], smile: null, term: [], table: [],
    expiries: [1_800_000_000, 1_810_000_000].map((expiration) => ({ expiration, years: 0.5, state: "ready", stale: false,
      error: null, source: "test", asOf: "2026-09-22T13:45:00Z", rate: 0.04, rateAsOf: ["2026-09-21"],
      forward: 100, fitMethod: "monotone-cubic", sourcePointCount: 2 })),
    grid: { tenors: [0.25, 0.5], coordinates: [0.9, 1], values: [[0.3, 0.25], [0.32, 0.27]] },
  };
  const nodes = (value: Record<string, unknown> = metadata): RemoteUiNodeSnapshot[] => [
    { id: "surface-data", role: "chart-data", actions: [], metadata: value },
  ];

  test("verifies numeric surface cells and provenance despite a live-dom capability with no table rows", () => {
    expect(shotSemanticRowCount(request, source, nodes())).toBe(4);
    expect(shotUnavailableSymbols(request, source, nodes())).toEqual([]);
    expect(paneEvidenceMismatches(request, source, { semanticUi: nodes() })).toEqual([]);
    expect(shotDataEvidenceFor(request, source, nodes())).toMatchObject({
      kind: "volatility-surface", grid: metadata.grid, spotAsOf: "2026-09-22T14:00:00Z", plottedValueCount: 4,
    });
    expect(shotSemanticRowCount(request, source, [])).toBe(0);
    expect(shotDataEvidenceFor(request, source, [])).toBeNull();
  });

  test("does not certify canvas-only, wrong-view, partial or empty captures", () => {
    expect(shotUnavailableSymbols(request, source, [])).toEqual(["AAPL"]);
    const partial = nodes({ ...metadata, complete: false, failedExpiries: 1, failures: [{ expiration: 1_800_000_000, message: "offline" }] });
    expect(shotUnavailableSymbols(request, source, partial)).toEqual(["AAPL"]);
    expect(shotSemanticRowCount(request, source, partial)).toBe(4);
    expect(paneEvidenceMismatches({ ...request, options: { ...request.options, tab: "smile" } }, source, { semanticUi: nodes() })).toContain("rendered volatility view does not match");
    expect(paneEvidenceMismatches(request, source, { semanticUi: nodes({ ...metadata, symbol: "TSLA" }) })).toContain("rendered volatility symbol does not match");
    expect(paneEvidenceMismatches(request, source, { semanticUi: nodes({ ...metadata, ivSource: "provider" }) })).toContain("rendered volatility source does not match");
    const empty = nodes({ ...metadata, plottedValueCount: 0, validQuadCount: 0,
      grid: { ...metadata.grid, values: [[null, null], [null, null]] } });
    expect(shotSemanticRowCount(request, source, empty)).toBe(0);
    expect(shotDataEvidenceFor(request, source, empty)).toBeNull();
  });
});

describe("realized volatility screenshot evidence", () => {
  const source = payload([["AAPL", { quote: { price: 100 } }]]);
  const status = { symbol: "AAPL", view: "graph" as const, estimator: "close-to-close", windows: [10],
    lookbackYears: 1, showIv: true, loading: false, stale: false, source: "test", asOf: "2026-09-22T00:00:00Z", errors: [],
    currentIv: { value: 22, date: "2026-09-22T14:30:00.000Z", label: "ATM IV 24d", source: "test", expiration: 1_800_000_000 } };
  const dates = [new Date("2026-09-21"), new Date("2026-09-22")];
  const series = realizedChartSeries({ history: dates.map((date) => ({ date, close: 100 })),
    rolling: dates.map((date, index) => ({ date, values: { 10: index ? 0.2 : null } })), windows: [10], currency: "USD",
    iv: { value: 0.22, date: new Date(status.currentIv.date), label: status.currentIv.label } }, ["green"], "white");
  const evidence = realizedVolSemanticEvidence(series, status);
  const request = { ...resolved("realized-vol-graph-pane", { tab: "graph", windows: "10", showIv: true }),
    pane: { id: "realized-vol" }, capability: { id: "realized-vol-graph-pane", screenshotReadiness: "live-dom" } } as ResolvedPaneFunction;
  const nodes = (metadata: object = evidence): RemoteUiNodeSnapshot[] => [
    { id: "hvg-data", role: "chart-data", actions: [], metadata: { ...metadata } },
  ];

  test("certifies actual HVG values and one dated IV point without table rows", () => {
    expect(shotSemanticRowCount(request, source, nodes())).toBe(4);
    expect(shotUnavailableSymbols(request, source, nodes())).toEqual([]);
    expect(paneEvidenceMismatches(request, source, { semanticUi: nodes() })).toEqual([]);
    expect(shotDataEvidenceFor(request, source, nodes())).toMatchObject({ series: [
      { id: "hv-10", points: [{ date: dates[0]!.toISOString(), value: null }, { date: dates[1]!.toISOString(), value: 20 }] },
      { id: "current-iv", points: [{ date: status.currentIv.date, value: 22 }] },
      { id: "price", points: dates.map((date) => ({ date: date.toISOString(), value: 100 })) },
    ] });
  });

  test("certifies HVT numeric session coordinates independently of history dates", () => {
    const cone = realizedVolSemanticEvidence(coneChartSeries([{ window: 10, current: 0.2, min: 0.1, max: 0.4,
      mean: 0.25, median: 0.22, percentile: 40, sampleSize: 250 }], ["a", "b", "c", "d"]), { ...status, view: "cone" });
    const hvt = { ...request, options: { ...request.options, tab: "cone" } };
    expect(shotSemanticRowCount(hvt, source, nodes(cone))).toBe(4);
    expect(paneEvidenceMismatches(hvt, source, { semanticUi: nodes(cone) })).toEqual([]);
    expect(shotUnavailableSymbols(hvt, source, nodes(cone))).toEqual([]);
  });

  test("rejects invented counts, price-only charts, mismatched settings and stale or pending data", () => {
    expect(shotDataEvidenceFor(request, source, [])).toBeNull();
    expect(shotDataEvidenceFor(request, source, nodes({ ...evidence, plottedValueCount: 200 }))).toBeNull();
    expect(shotDataEvidenceFor(request, source, nodes({ ...evidence, series: evidence.series.slice(-1), plottedValueCount: 2 }))).toBeNull();
    expect(shotDataEvidenceFor(request, source, nodes({ ...evidence, currentIv: { ...status.currentIv, value: 99 } }))).toBeNull();
    expect(paneEvidenceMismatches(request, source, {
      semanticUi: nodes({ ...evidence, symbol: "SPY", estimator: "parkinson", view: "cone" }),
    })).not.toEqual([]);
    for (const state of [{ stale: true }, { loading: true }, { errors: ["History unavailable"] }]) {
      expect(shotUnavailableSymbols(request, source, nodes({ ...evidence, ...state, complete: false }))).toEqual(["AAPL"]);
      expect(shotDataEvidenceFor(request, source, nodes({ ...evidence, ...state }))).toBeNull();
    }
  });
});

describe("pane screenshot rendered readiness", () => {
  const rendered = {
    rowCount: 2,
    loadingStateDetected: false,
    errorStateDetected: false,
    emptyStateDetected: false,
    complete: true,
    semanticMismatch: false,
    requiresStructuredDataEvidence: false,
    hasStructuredDataEvidence: false,
  };

  test("requires rows without loading, error, or empty states", () => {
    expect(isPaneScreenshotUsable(rendered)).toBe(true);
    expect(isPaneScreenshotUsable({ ...rendered, rowCount: 0 })).toBe(false);
    expect(isPaneScreenshotUsable({ ...rendered, loadingStateDetected: true })).toBe(false);
    expect(isPaneScreenshotUsable({ ...rendered, errorStateDetected: true })).toBe(false);
    expect(isPaneScreenshotUsable({ ...rendered, emptyStateDetected: true })).toBe(false);
  });

  test("preserves mapped capability completeness and evidence checks", () => {
    expect(isPaneScreenshotUsable({ ...rendered, complete: false })).toBe(false);
    expect(isPaneScreenshotUsable({ ...rendered, semanticMismatch: true })).toBe(false);
    expect(isPaneScreenshotUsable({
      ...rendered,
      requiresStructuredDataEvidence: true,
    })).toBe(false);
    expect(isPaneScreenshotUsable({
      ...rendered,
      requiresStructuredDataEvidence: true,
      hasStructuredDataEvidence: true,
    })).toBe(true);
  });
});

describe("pane screenshot payload credentials", () => {
  test("keeps the restored session in the proxy and strips credential fields from page data", () => {
    const sessionToken = "private-shot-session";
    const proxy = resolveDesktopShotApiProxy({
      persistence: {
        pluginState: {
          get: (_pluginId: string, key: string) => key === "resume:session"
            ? { value: { sessionToken }, schemaVersion: 1, updatedAt: 1 }
            : null,
        },
      },
    } as any);
    const payload = stripDesktopShotCredentials({
      config: {
        theme: "tokyo",
        pluginConfig: {
          service: { apiKey: "private-api-key", display: "compact" },
        },
        brokerInstances: [{ config: { password: "private-password", region: "US" } }],
      },
      paneState: {
        pane: { pluginState: { service: { accessToken: "private-access", tab: "latest" } } },
      },
    });

    expect(proxy.sessionToken).toBe(sessionToken);
    expect(payload).toEqual({
      config: {
        theme: "tokyo",
        pluginConfig: { service: { display: "compact" } },
        brokerInstances: [{ config: { region: "US" } }],
      },
      paneState: { pane: { pluginState: { service: { tab: "latest" } } } },
    });
    expect(JSON.stringify(payload)).not.toContain("private-");
  });
});

describe("pane screenshot market bridge", () => {
  /**
   * The page can only reach the cloud API on its own, and the cloud carries no
   * per-rating price targets. Serving research requests from the router is what
   * keeps a screenshot showing the same values as `gloomberb fn`.
   */
  test("answers research requests from the routed provider and refuses anything else", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const bridge = createDesktopShotBridge({
      dataProvider: {
        getAnalystResearch: (...args: unknown[]) => {
          calls.push(["getAnalystResearch", args]);
          return Promise.resolve({ symbol: "NKE", ratings: [{ currentPriceTarget: 42 }] });
        },
      } as any,
    });

    expect(await bridge.marketData("getAnalystResearch", ["NKE", "NYSE"])).toEqual({
      symbol: "NKE",
      ratings: [{ currentPriceTarget: 42 }],
    });
    expect(calls).toEqual([["getAnalystResearch", ["NKE", "NYSE"]]]);
    await expect(bridge.marketData("getCachedQuery", ["NKE"])).rejects.toThrow(/does not serve/);
  });

  test("routes distinct option expiries with their listing and request context intact", async () => {
    const calls: unknown[][] = [];
    const provider = {
      async getOptionsChain(...args: unknown[]) {
        expect(this).toBe(provider);
        calls.push(args);
        return { underlyingSymbol: args[0], expirationDates: [args[2]], calls: [], puts: [], asOf: "2026-09-21T20:00:00Z" };
      },
    };
    const bridge = createDesktopShotBridge({ dataProvider: provider as any });
    const context = { cacheMode: "refresh" };
    for (const expiry of [1_790_121_600, 1_792_108_800]) {
      const result = await bridge.marketData("getOptionsChain", ["AAPL", "NASDAQ", expiry, context]);
      expect(result).toMatchObject({ expirationDates: [expiry], asOf: "2026-09-21T20:00:00Z" });
    }
    expect(calls).toEqual([
      ["AAPL", "NASDAQ", 1_790_121_600, context],
      ["AAPL", "NASDAQ", 1_792_108_800, context],
    ]);
  });

  test("routes exact daily index resolution through the host and never substitutes range history", async () => {
    const calls: unknown[][] = [];
    const points = [{ date: new Date("2026-09-22T15:42:16Z"), close: 21.73 }];
    const provider = {
      async getPriceHistoryForResolution(...args: unknown[]) { expect(this).toBe(provider); calls.push(args); return points; },
      async getPriceHistory() { throw new Error("Range-only cadence must not be substituted"); },
    };
    const args = ["^VIX1Y", "", "1Y", "1d", { cacheMode: "refresh" }];
    expect(await createDesktopShotBridge({ dataProvider: provider as any }).marketData("getPriceHistoryForResolution", args)).toEqual(points);
    expect(calls).toEqual([args]);
    const absent = createDesktopShotBridge({ dataProvider: { getPriceHistory: provider.getPriceHistory } as any });
    await expect(absent.marketData("getPriceHistoryForResolution", args)).rejects.toThrow("No provider available for getPriceHistoryForResolution");
    const failed = createDesktopShotBridge({ dataProvider: { getPriceHistoryForResolution: async () => { throw new Error("Source unavailable"); } } as any });
    await expect(failed.marketData("getPriceHistoryForResolution", args)).rejects.toThrow("Source unavailable");
  });
});

describe("pane screenshot active-state verification", () => {
  const expected: PaneScreenshotExpectedSelection[] = [
    { control: "statement", label: "Cash Flow" },
    { control: "period", value: "annual" },
  ];

  test("accepts selections confirmed by the rendered semantic tab state", () => {
    expect(missingActiveTabSelections(renderedTabs("1", "annual"), expected)).toEqual([]);
  });

  test("rejects labels that are visible but not active", () => {
    expect(missingActiveTabSelections(renderedTabs("0", "quarterly"), expected))
      .toEqual(expected);
  });

  test("reads the active choices of a query bar", () => {
    const queryBar = (statement: string, period: string): RemoteUiNodeSnapshot[] => [{
      id: "query",
      role: "query-bar",
      actions: [],
      metadata: {
        selections: [
          { id: "statement", value: statement === "Cash Flow" ? "1" : "0", label: statement },
          { id: "view", value: period, label: period === "annual" ? "Annual" : "Quarterly" },
        ],
      },
    }];
    expect(missingActiveTabSelections(queryBar("Cash Flow", "annual"), expected)).toEqual([]);
    expect(missingActiveTabSelections(queryBar("Income", "quarterly"), expected)).toEqual(expected);
  });
});

describe("pane screenshot chart-data verification", () => {
  const expected: PaneScreenshotExpectedChartEvidence = {
    kind: "price-comparison",
    symbols: ["AAPL", "NVDA"],
    rangePreset: "1Y",
    axisMode: "percent",
    resolution: "1d",
    sourceSeries: [
      {
        symbol: "AAPL",
        pointCount: 2,
        first: { date: "2025-07-17T00:00:00.000Z", close: 100 },
        last: { date: "2026-07-18T00:00:00.000Z", close: 150 },
        projectionBaseValue: 110,
        projectionLatestRawValue: 150,
        projectionLatestValue: 36.36363636363637,
      },
      {
        symbol: "NVDA",
        pointCount: 2,
        first: { date: "2025-07-17T00:00:00.000Z", close: 200 },
        last: { date: "2026-07-18T00:00:00.000Z", close: 220 },
        projectionBaseValue: 205,
        projectionLatestRawValue: 220,
        projectionLatestValue: 7.317073170731708,
      },
    ],
  };

  test("accepts exact rendered comparison inputs and projection values", () => {
    expect(chartEvidenceMismatchesFor(renderedComparisonChart(), expected)).toEqual([]);
  });

  test("matches the exact chart window when the latest point is later in the day", () => {
    expect(chartSeriesEvidenceWithinRange("MSFT", [
      { date: new Date("2021-07-22T13:30:00.000Z"), close: 286.14 },
      { date: new Date("2021-07-23T13:30:00.000Z"), close: 289.67 },
      { date: new Date("2026-07-22T18:39:00.000Z"), close: 505.12 },
    ], "5Y")).toEqual({
      symbol: "MSFT",
      pointCount: 2,
      first: { date: "2021-07-23T13:30:00.000Z", close: 289.67 },
      last: { date: "2026-07-22T18:39:00.000Z", close: 505.12 },
    });
  });

  test("rejects a wrong range or rendered value even when symbols are visible", () => {
    const nodes = renderedComparisonChart();
    nodes[0]!.metadata!.rangePreset = "3M";
    (nodes[0]!.metadata!.projectionSeries as Array<Record<string, unknown>>)[0]!.latestRawValue = 149;
    expect(chartEvidenceMismatchesFor(nodes, expected)).toEqual([
      "rendered chart range does not match",
      "AAPL comparison latest value does not match",
    ]);
  });

  test("accepts resolved mixed-source composer evidence", () => {
    const expectedComposer: PaneScreenshotExpectedChartEvidence = {
      kind: "chart-composer",
      symbols: ["AAPL", "MSFT"],
      rangePreset: "5Y",
      resolution: "auto",
      baseSeries: [
        {
          id: "aapl-price",
          sourceKind: "security",
          symbol: "AAPL",
          fieldId: "market.ohlcv",
          style: "candles",
          transform: "raw",
          panelId: "main",
          visible: true,
        },
        {
          id: "msft-revenue",
          sourceKind: "security",
          symbol: "MSFT",
          fieldId: "fundamental.totalRevenue",
          style: "step",
          transform: "raw",
          panelId: "main",
          visible: true,
        },
        {
          id: "cpi",
          sourceKind: "economic",
          economicSeriesId: "CPIAUCSL",
          style: "step",
          transform: "raw",
          panelId: "macro",
          visible: true,
        },
        {
          id: "prediction",
          sourceKind: "capability",
          capabilityId: "prediction-markets.series",
          providerSeriesId: "polymarket/event-1/market-1",
          first: { date: "2026-01-01T00:00:00.000Z", value: 0.4 },
          last: { date: "2026-01-02T00:00:00.000Z", value: 0.6 },
          style: "area",
          transform: "raw",
          panelId: "prediction",
          visible: true,
        },
      ],
    };
    const metadata = {
      ...expectedComposer,
      projectedPointCount: 42,
      baseSeries: expectedComposer.baseSeries?.map((series) => ({ ...series, pointCount: 12 })),
    };
    const semanticUi = [{
      id: "chart-composer-data",
      role: "chart-data" as const,
      actions: [],
      metadata,
    }];
    expect(chartEvidenceMismatchesFor(semanticUi, expectedComposer)).toEqual([]);

    const wrong = structuredClone(semanticUi);
    (wrong[0]!.metadata.baseSeries![3]!.last as { value: number }).value = 0.7;
    expect(chartEvidenceMismatchesFor(wrong, expectedComposer))
      .toContain("rendered chart series prediction does not match");
  });
});

describe("pane screenshot chart-composer inputs", () => {
  test("loads security symbols from the parsed chart spec instead of treating the expression as one ticker", () => {
    const rawArg = "AAPL:price, MSFT:revenue, 3HNX:LSE:revenue, FRED:CPIAUCSL";
    const chart = {
      pane: { id: CHART_COMPOSER_PANE_ID },
      instance: { settings: { chartSpec: buildCustomChartPreset(rawArg) } },
      createOptions: { arg: rawArg },
    } as unknown as ResolvedPaneFunction;

    expect(collectShotSymbols(chart, rawArg)).toEqual(["AAPL", "MSFT", "3HNX:XLON"]);
  });

  test("uses rendered composer series for FRED-only screenshot readiness", () => {
    const composer = resolved("chart-composer", {});
    const semanticUi: RemoteUiNodeSnapshot[] = [{
      id: "chart-composer-data",
      role: "chart-data",
      actions: [],
      metadata: {
        kind: "chart-composer",
        baseSeries: [{
          sourceKind: "economic",
          economicSeriesId: "CPIAUCSL",
          pointCount: 12,
        }],
      },
    }];

    expect(shotSemanticRowCount(composer, payload([]), semanticUi)).toBe(12);
    expect(shotUnavailableSymbols(composer, payload([]), semanticUi)).toEqual([]);
  });

  test("accepts capability-backed composer evidence and reports an empty provider series", () => {
    const composer = resolved("chart-composer", {});
    const populated: RemoteUiNodeSnapshot[] = [{
      id: "chart-composer-data",
      role: "chart-data",
      actions: [],
      metadata: {
        kind: "chart-composer",
        baseSeries: [{
          sourceKind: "capability",
          capabilityId: "prediction-markets.series",
          providerSeriesId: "polymarket:one",
          pointCount: 5,
        }],
      },
    }];
    expect(shotSemanticRowCount(composer, payload([]), populated)).toBe(5);
    expect(shotUnavailableSymbols(composer, payload([]), populated)).toEqual([]);

    const empty = structuredClone(populated);
    (empty[0]!.metadata as any).baseSeries[0].pointCount = 0;
    expect(shotUnavailableSymbols(composer, payload([]), empty))
      .toEqual(["CAP:prediction-markets.series:polymarket:one"]);
  });

  test("expects the composer legend short label, not the catalog metric label", () => {
    const valuation = {
      ...resolved("valuation-series", { metric: "priceSales", period: "annual" }),
      pane: { id: CHART_COMPOSER_PANE_ID },
    } as unknown as ResolvedPaneFunction;

    expect(shotExpectedText(valuation, ["AAPL"], payload([]))).toEqual(["AAPL", "P/S"]);
  });

  test("reports an empty FRED composer source as unavailable", () => {
    const semanticUi: RemoteUiNodeSnapshot[] = [{
      id: "chart-composer-data",
      role: "chart-data",
      actions: [],
      metadata: {
        kind: "chart-composer",
        baseSeries: [{
          sourceKind: "economic",
          economicSeriesId: "UNRATE",
          pointCount: 0,
        }],
      },
    }];

    expect(shotUnavailableSymbols(resolved("chart-composer", {}), payload([]), semanticUi))
      .toEqual(["FRED:UNRATE"]);
  });
});

describe("pane screenshot structured data evidence", () => {
  test("captures the exact single-price series rendered by a price chart", () => {
    const evidence = shotDataEvidenceFor(
      resolved("price-chart", { rangePreset: "3M" }),
      payload([["AAPL", {
        priceHistory: [
          { date: "2026-04-01", close: 100 },
          { date: "2026-07-01", close: 125 },
        ],
      }]]),
    );

    expect(evidence).toEqual({
      kind: "price-series",
      symbol: "AAPL",
      range: "3M",
      pointCount: 2,
      first: { date: "2026-04-01T00:00:00.000Z", close: 100 },
      last: { date: "2026-07-01T00:00:00.000Z", close: 125 },
    });
  });

  test("captures the exact comparison projection inputs and return", () => {
    const evidence = shotDataEvidenceFor(
      resolved("price-comparison", { rangePreset: "1Y", axisMode: "percent" }),
      payload([
        ["AAPL", {
          priceHistory: [
            { date: "2025-07-01", close: 100 },
            { date: "2026-07-01", close: 150 },
          ],
        }],
        ["NVDA", {
          priceHistory: [
            { date: "2025-07-01", close: 200 },
            { date: "2026-07-01", close: 220 },
          ],
        }],
      ]),
    );

    expect(evidence).toEqual({
      kind: "price-comparison",
      symbols: ["AAPL", "NVDA"],
      range: "1Y",
      series: [
        {
          symbol: "AAPL",
          base: { date: "2025-07-01T00:00:00.000Z", value: 100 },
          latest: { date: "2026-07-01T00:00:00.000Z", value: 150 },
          returnPercent: 50,
        },
        {
          symbol: "NVDA",
          base: { date: "2025-07-01T00:00:00.000Z", value: 200 },
          latest: { date: "2026-07-01T00:00:00.000Z", value: 220 },
          returnPercent: 10,
        },
      ],
    });
  });

  test("captures rendered fundamental rows and headline statement values", () => {
    const financials = {
      priceHistory: [],
      annualStatements: [
        {
          date: "2025-01-31",
          totalRevenue: 100,
          operatingCashFlow: 30,
          capitalExpenditure: -10,
          freeCashFlow: 20,
        },
        {
          date: "2026-01-31",
          totalRevenue: 120,
          operatingCashFlow: 42,
          capitalExpenditure: -12,
          freeCashFlow: 30,
        },
      ],
      quarterlyStatements: [],
    };
    const graphEvidence = shotDataEvidenceFor(
      resolved("fundamental-series", {
        metric: "operatingCashFlow",
        period: "annual",
        periods: 2,
      }),
      payload([["NVDA", financials]]),
    );
    expect(graphEvidence).toEqual({
      kind: "fundamental-series",
      metric: "operatingCashFlow",
      period: "annual",
      series: [{
        symbol: "NVDA",
        rows: [
          { date: "2025-01-31", value: 30 },
          { date: "2026-01-31", value: 42 },
        ],
      }],
    });

    const statementEvidence = shotDataEvidenceFor(
      resolved("financial-statements", { statement: "cashflow", period: "annual" }),
      payload([["NVDA", financials]]),
    );
    expect(statementEvidence).toMatchObject({
      kind: "financial-statement",
      symbol: "NVDA",
      statement: "cashflow",
      period: "annual",
      latest: {
        date: "2026-01-31",
        metrics: expect.arrayContaining([
          expect.objectContaining({ key: "operatingCashFlow", value: 42 }),
          expect.objectContaining({ key: "capitalExpenditure", value: -12 }),
          expect.objectContaining({ key: "freeCashFlow", value: 30 }),
        ]),
      },
    });
  });
});

function resolved(
  capabilityId: string,
  options: Record<string, string | number>,
): ResolvedPaneFunction {
  return {
    capability: { id: capabilityId },
    options,
  } as unknown as ResolvedPaneFunction;
}

function payload(
  financials: Array<[string, Record<string, unknown>]>,
): DesktopPaneShotPayload {
  return {
    financials: financials.map(([symbol, value]) => [
      symbol,
      {
        quote: null,
        fundamentals: null,
        profile: null,
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
        ...value,
      },
    ]),
  } as unknown as DesktopPaneShotPayload;
}

function renderedTabs(statement: string, period: string): RemoteUiNodeSnapshot[] {
  return [
    {
      id: "statements",
      role: "tabs",
      actions: [],
      metadata: {
        activeValue: statement,
        tabs: [
          { label: "Income", value: "0" },
          { label: "Cash Flow", value: "1" },
          { label: "Balance Sheet", value: "2" },
        ],
      },
    },
    {
      id: "period",
      role: "tabs",
      actions: [],
      metadata: {
        activeValue: period,
        tabs: [
          { label: "Annual", value: "annual" },
          { label: "Quarterly", value: "quarterly" },
        ],
      },
    },
  ];
}

function renderedComparisonChart(): RemoteUiNodeSnapshot[] {
  return [{
    id: "comparison-chart-data",
    role: "chart-data",
    actions: [],
    metadata: {
      kind: "price-comparison",
      symbols: ["AAPL", "NVDA"],
      rangePreset: "1Y",
      selectedResolution: "1d",
      effectiveResolution: "1d",
      requestedAxisMode: "percent",
      effectiveAxisMode: "percent",
      sourceSeries: [
        {
          symbol: "AAPL",
          pointCount: 2,
          first: { date: "2025-07-17T00:00:00.000Z", close: 100 },
          last: { date: "2026-07-18T00:00:00.000Z", close: 150 },
        },
        {
          symbol: "NVDA",
          pointCount: 2,
          first: { date: "2025-07-17T00:00:00.000Z", close: 200 },
          last: { date: "2026-07-18T00:00:00.000Z", close: 220 },
        },
      ],
      projectedPointCount: 2,
      projectionSeries: [
        {
          symbol: "AAPL",
          baseValue: 110,
          latestRawValue: 150,
          latestValue: 36.36363636363637,
          pointCount: 2,
        },
        {
          symbol: "NVDA",
          baseValue: 205,
          latestRawValue: 220,
          latestValue: 7.317073170731708,
          pointCount: 2,
        },
      ],
    },
  }];
}

test("screenshot bridge fetches tape through Bun with the exact listing identity", async () => {
  const calls:string[][]=[];
  const bridge=createDesktopShotBridge({dataProvider:{} as any},async(symbol,exchange)=>{
    calls.push([symbol,exchange]);
    return {symbol,exchange,trades:[{id:"18446744073709551615",timestamp:"2026-09-22T16:59:58.545074403Z"}]} as any;
  });
  expect(await bridge.marketData("getCloudTape",["AAPL","NASDAQ"])).toMatchObject({trades:[{id:"18446744073709551615",timestamp:"2026-09-22T16:59:58.545074403Z"}]});
  expect(calls).toEqual([["AAPL","NASDAQ"]]);
  await expect(bridge.marketData("getCloudTape",["AAPL"])).rejects.toThrow("listing exchange");
});

describe("portfolio screenshot members", () => {
  const request = {
    pane: { id: "portfolio-list" }, capability: { id: "portfolio-list-pane", options: [] },
    instance: { instanceId: "pf:test", paneId: "portfolio-list", binding: { kind: "none" }, settings: {} }, options: {},
  } as unknown as ResolvedPaneFunction;
  const option = MARGIN_TICKERS.find(({ metadata }) => metadata.assetCategory === "OPT")!;
  const quotes = marginQuotes();
  const capture = (provider: Partial<MarketContext["dataProvider"]> = {}, held = MARGIN_TICKERS) => buildDesktopShotPayload(request, {
    config: { ...createDefaultConfig("/tmp/portfolio-shot-test"), portfolios: [MARGIN_PORTFOLIO] },
    store: {
      loadAllTickers: async () => held,
      loadTicker: async (symbol: string) => held.find(({ metadata }) => metadata.ticker === symbol) ?? null,
    },
    dataProvider: createTestDataProvider({
      getTickerFinancials: async (symbol) => {
        const financials = quotes.get(symbol);
        if (!financials) throw new Error(`Cloud financials are unavailable for ${symbol}`);
        return financials;
      },
      ...provider,
    }),
  } as unknown as MarketContext, "", {}, 1200, 800, null, 1, null);

  test("a holding no quote prices stays at its broker mark instead of failing the capture", async () => {
    const shot = await capture();
    expect(shot.tickers.map(({ metadata }) => metadata.ticker)).toEqual(["AAA", "BBB", option.metadata.ticker]);
    expect(shot.financials.map(([symbol]) => symbol)).toEqual(["AAA", "BBB"]);
    expect(shot.tickers.at(-1)!.metadata.positions[0]).toMatchObject({ markPrice: 100, multiplier: 100 });
  });

  test("still fails for a holding the broker never marked", async () => {
    const [stock] = MARGIN_TICKERS;
    const unmarked = { metadata: { ...stock!.metadata, positions: [{ ...stock!.metadata.positions[0]!, markPrice: undefined, marketValue: undefined }] } };
    await expect(capture({
      getTickerFinancials: async (symbol) => {
        if (symbol === "AAA") throw new Error("Cloud financials are unavailable for AAA");
        return quotes.get(symbol)!;
      },
    }, [unmarked, ...MARGIN_TICKERS.slice(1)])).rejects.toThrow("unavailable for AAA");
  });
});
