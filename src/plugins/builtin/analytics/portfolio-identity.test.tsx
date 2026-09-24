import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer, useState, type ReactElement } from "react";
import { settleFrame, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { buildChartKey } from "../../../market-data/selectors";
import { upsertBrokerPositionTicker } from "../../../brokers/broker-ticker-sync";
import type { TickerRecord } from "../../../types/ticker";
import type { TickerFinancials } from "../../../types/financials";
import type { PaneProps } from "../../../types/plugin";
import { apiClient, type AccountProfile } from "../../../api-client";
import { chatController } from "../chat/controller";
import { cloudSyncController } from "../../../sync/controller";
import { AccountManagementPane } from "../account-management/pane";
import { buildPortfolioChartTargets, buildPortfolioReturnSeries } from "./pane-model";
import { buildPortfolioFinancialsMap } from "../../../market-data/portfolio-financials";
import { useTickerFinancialsMap } from "../../../market-data/hooks";
import { Text } from "../../../ui";
import { PortfolioListPane } from "../portfolio-list/pane";
import { KellySizerPane } from "../kelly-sizer/pane";
import { buildSectorRowsFromPortfolioColumns } from "./sector-model";
import { portfolioAnalyticsModule } from "./index";

const paneId = "analytics:identity";
const AnalyticsPane = portfolioAnalyticsModule.panes![0]!.component as (props: PaneProps) => ReactElement;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let latestState: ReturnType<typeof createInitialState>;
const restore: Array<() => void> = [];

function financials(symbol: string, price: number): TickerFinancials {
  return { annualStatements: [], quarterlyStatements: [], priceHistory: [], profile: { sector: "Technology" },
    quote: { symbol, price, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() } };
}

function fixture(reverse = false, missingQuote?: string) {
  const tickers = new Map<string, TickerRecord>();
  for (const [id, price, conId] of [["a", 100, 101], ["b", 200, 202]] as const) {
    const { ticker } = upsertBrokerPositionTicker({ tickers,
      instance: { id: `feed-${id}`, brokerType: "ibkr", label: id, config: {}, enabled: false }, portfolioId: id,
      position: { ticker: "ACME", exchange: "NASDAQ", currency: "USD", shares: 10, avgCost: price * .8, markPrice: price,
        brokerContract: { brokerId: "ibkr", conId, symbol: "ACME", currency: "USD", secType: "STK", exchange: "NASDAQ" } },
    });
    ticker.metadata.sector = "Technology";
    tickers.set("ACME", ticker);
  }
  if (reverse) tickers.get("ACME")!.metadata.broker_contracts!.reverse();
  for (const [symbol, sector, assetCategory] of [["ENERGY", "Energy", "STK"], ["MIXETF", "Technology", "ETF"]]) {
    tickers.set(symbol!, { metadata: { ticker: symbol!, name: symbol!, exchange: "NASDAQ", currency: "USD", sector, assetCategory,
      portfolios: ["a", "b"], watchlists: [], custom: {}, tags: [], positions: ["a", "b"].map(portfolio => ({
        portfolio, shares: 10, avgCost: 80, markPrice: 100, currency: "USD", broker: "manual",
      })) } });
  }
  const coordinator = new MarketDataCoordinator(createTestDataProvider());
  for (const id of ["a", "b"]) {
    if (id === missingQuote) continue;
    coordinator.primeCachedFinancials([{ instrument: instrumentFromTicker(tickers.get("ACME"), "ACME", { portfolioId: id })!,
      financials: financials("ACME", id === "a" ? 100 : 200) }]);
  }
  return { tickers, coordinator };
}

function Harness({ f, portfolio = "a", cached = new Map(), profile = false, view }: {
  f: ReturnType<typeof fixture>; portfolio?: string; cached?: Map<string, TickerFinancials>; profile?: boolean; view?: "portfolio-list" | "kelly-sizer";
}) {
  const config = createTestPaneConfig("/tmp/portfolio-identity-unused", {
    instanceId: paneId, paneId: view ?? (profile ? "account-management" : "analytics"), binding: { kind: "none" },
    params: { portfolioId: portfolio, collectionId: portfolio, symbol: "ACME" }, settings: { columnIds: ["ticker", "mkt_value", "pnl", "weight"] },
  });
  config.portfolios = [{ id: "a", name: "First account", currency: "USD" }, { id: "b", name: "Second account", currency: "USD" }];
  const initial = createInitialState(config);
  initial.focusedPaneId = paneId;
  initial.paneState[paneId] = { portfolioId: portfolio, collectionId: portfolio, symbol: "ACME" };
  initial.tickers = f.tickers;
  initial.financials = cached;
  const [state, dispatch] = useReducer(appReducer, initial);
  latestState = state;
  return <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="portfolio" runtime={createTestPluginRuntime()}>
    {view === "portfolio-list" ? <PortfolioListPane paneId={paneId} paneType={view} focused width={80} height={32} />
      : view === "kelly-sizer" ? <KellySizerPane paneId={paneId} paneType={view} focused width={80} height={32} />
      : profile ? <AccountManagementPane paneId={paneId} paneType="account-management" focused width={80} height={40} />
      : <AnalyticsPane paneId={paneId} paneType="analytics" focused width={80} height={32} />}
  </TestPaneProvider>;
}

async function render(f: ReturnType<typeof fixture>, portfolio = "a", cached = new Map<string, TickerFinancials>(), profile = false, view?: "portfolio-list" | "kelly-sizer") {
  setSharedMarketDataCoordinator(f.coordinator);
  await act(async () => { setup = await testRender(<Harness f={f} portfolio={portfolio} cached={cached} profile={profile} view={view} />, { width: 80, height: profile ? 40 : 32 }); });
  await settleFrame(setup!, 20);
}

afterEach(async () => {
  if (setup) { await act(async () => setup!.renderer.destroy()); setup = undefined; }
  while (restore.length) restore.pop()!();
  setSharedMarketDataCoordinator(null);
});

test("scoped chart and financial models keep account identity independently of contract order", () => {
  for (const reverse of [false, true]) {
    const f = fixture(reverse), tickers = [...f.tickers.values()];
    for (const portfolioId of ["a", "b"]) {
      const options = { portfolioId };
      const targets = buildPortfolioChartTargets(tickers, options);
      expect(targets[0]!.request.instrument.instrument?.conId).toBe(portfolioId === "a" ? 101 : 202);
      const market = new Map(tickers.flatMap(ticker => {
        const value = f.coordinator.getTickerFinancialsSync(instrumentFromTicker(ticker, ticker.metadata.ticker, options)!);
        return value ? [[ticker.metadata.ticker, value] as const] : [];
      }));
      const merged = buildPortfolioFinancialsMap(tickers, new Map(), market, options);
      const result = buildSectorRowsFromPortfolioColumns(tickers, merged, { activeTab: portfolioId, baseCurrency: "USD", exchangeRates: new Map(), now: 0 });
      expect(result.rows.find(row => row.sector === "Technology")?.weight).toBe(portfolioId === "a" ? 1 / 3 : .5);
      expect(result.fundSymbols).toEqual(["MIXETF"]);
      expect(result.unvaluedSymbols).toEqual([]);
    }
    expect(buildChartKey(buildPortfolioChartTargets(tickers, { portfolioId: "a" })[0]!.request))
      .not.toBe(buildChartKey(buildPortfolioChartTargets(tickers, { portfolioId: "b" })[0]!.request));
  }
});

test("unscoped cached prices cannot cross into either broker account, while generic fields and manual quotes survive", () => {
  const f = fixture(), tickers = [...f.tickers.values()];
  const cachedQuote = financials("ACME", 999);
  cachedQuote.priceHistory = [{ date: new Date("2026-09-01"), close: 999 }];
  cachedQuote.fundamentals = { trailingPE: 20 };
  const manual = financials("ENERGY", 110), cached = new Map([["ACME", cachedQuote], ["ENERGY", manual]]);
  for (const portfolioId of ["a", "b"]) {
    const merged = buildPortfolioFinancialsMap(tickers, cached, new Map(), { portfolioId });
    expect(merged.get("ACME")?.quote).toBeUndefined();
    expect(merged.get("ACME")?.priceHistory).toEqual([]);
    expect(merged.get("ACME")?.fundamentals).toBe(cachedQuote.fundamentals);
    expect(merged.get("ACME")?.profile).toBe(cachedQuote.profile);
    expect(merged.get("ENERGY")).toBe(manual);
  }
  expect(cachedQuote.quote?.price).toBe(999);
  expect(cachedQuote.priceHistory).toHaveLength(1);
});

test("actual analytics account switching changes quote, sector denominator and history request together", async () => {
  const f = fixture();
  const readChart = spyOn(f.coordinator, "getChartEntry"); restore.push(() => readChart.mockRestore());
  await render(f);
  expect(latestState.paneState[paneId]?.portfolioId).toBe("a");
  expect(setup!.captureCharFrame()).toContain("33.3%");
  await act(async () => { setup!.mockInput.pressArrow("right"); await setup!.renderOnce(); }); await settleFrame(setup!, 20);
  expect(latestState.paneState[paneId]?.portfolioId).toBe("b");
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("Val           4.0k");
  expect(frame).toContain("P&L           +800.00");
  expect(frame).toContain("Technology                50.0%       2.0k");
  expect(frame).not.toContain("Weights unavailable");
  const requested = readChart.mock.calls.filter(([request]) => request.instrument.symbol === "ACME").map(([request]) => request.instrument.instrument?.conId);
  expect(requested).toContain(101); expect(requested).toContain(202);
});

for (const portfolioId of ["a", "b"]) test(`actual analytics ${portfolioId} rejects the other account's symbol cache and recovers scoped quote`, async () => {
  const f = fixture(false, portfolioId), otherPrice = portfolioId === "a" ? 200 : 100;
  await render(f, portfolioId, new Map([["ACME", financials("ACME", otherPrice)]]));
  expect(setup!.captureCharFrame()).toContain(portfolioId === "a" ? "33.3%" : "50.0%");
  const ticker = f.tickers.get("ACME")!;
  await act(async () => f.coordinator.primeCachedFinancials([{ instrument: instrumentFromTicker(ticker, "ACME", { portfolioId })!, financials: financials("ACME", 300) }]));
  await settleFrame(setup!, 20);
  expect(setup!.captureCharFrame()).toContain("60.0%");
  expect(setup!.captureCharFrame()).toContain("Val           5.0k");
});

test("actual shared-portfolio preview uses its selected quote and history contracts", async () => {
  const stub = <T extends object, K extends keyof T>(object: T, method: K, implementation: any) => {
    const mock = spyOn(object, method as any).mockImplementation(implementation); restore.push(() => mock.mockRestore());
  };
  stub(apiClient, "isSignedIn", () => true);
  stub(apiClient, "getSessionToken", () => "controlled-test-session");
  stub(apiClient, "getCurrentUser", () => null);
  stub(apiClient, "getAccountProfile", async () => ({ sharedPortfolioId: "b", profilePublic: false } as AccountProfile));
  stub(apiClient, "getCloudPricing", async () => null);
  stub(chatController, "refreshSession", async () => {});
  stub(cloudSyncController, "schedulePush", () => {});
  const f = fixture();
  const quotes = spyOn(f.coordinator, "getTickerFinancialsSync"), charts = spyOn(f.coordinator, "getChartEntry");
  restore.push(() => quotes.mockRestore(), () => charts.mockRestore());
  await render(f, "a", new Map(), true);
  const selectedQuotes = quotes.mock.calls.filter(([request]) => request.symbol === "ACME");
  const selectedCharts = charts.mock.calls.filter(([request]) => request.instrument.symbol === "ACME");
  expect(selectedQuotes.length).toBeGreaterThan(0); expect(selectedCharts.length).toBeGreaterThan(0);
  expect(selectedQuotes.every(([request]) => request.instrument?.conId === 202)).toBe(true);
  expect(selectedCharts.every(([request]) => request.instrument.instrument?.conId === 202)).toBe(true);
});

test("unresolved selected contract skips market requests, keeps its own mark and does not disappear from risk coverage", async () => {
  const f = fixture();
  f.tickers.get("ACME")!.metadata.broker_contracts!.pop();
  const quotes = spyOn(f.coordinator, "getTickerFinancialsSync"), charts = spyOn(f.coordinator, "getChartEntry");
  restore.push(() => quotes.mockRestore(), () => charts.mockRestore());
  await render(f, "b", new Map([["ACME", financials("ACME", 999)]]));
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("Technology                50.0%       2.0k");
  expect(frame).toContain("Broker contract unavailable for ACME");
  expect(quotes.mock.calls.filter(([request]) => request.symbol === "ACME")).toEqual([]);
  expect(charts.mock.calls.filter(([request]) => request.instrument.symbol === "ACME")).toEqual([]);
  const targets = buildPortfolioChartTargets([...f.tickers.values()], { portfolioId: "b" });
  const obsolete = financials("ACME", 999);
  const guarded = buildPortfolioFinancialsMap([...f.tickers.values()], new Map(), new Map([["ACME", obsolete]]), { portfolioId: "b" });
  expect(guarded.get("ACME")?.quote).toBeUndefined();
  expect(guarded.get("ACME")?.profile).toBe(obsolete.profile);
  expect(targets).toHaveLength(3);
  expect(targets[0]!.request).toBeNull();
  const history = Array.from({ length: 21 }, (_, day) => ({ date: new Date(Date.UTC(2026, 7, day + 1)), close: 100 + day }));
  const chartEntries = new Map(targets.flatMap(target => target.request ? [[buildChartKey(target.request), { data: history }] as const] : []));
  const series = buildPortfolioReturnSeries({ chartTargets: targets, chartEntries, financials: new Map(),
    columnContext: { activeTab: "b", baseCurrency: "USD", exchangeRates: new Map(), now: 0 } });
  expect(series).toMatchObject({ returns: null, coverage: .5, missingCount: 1, unvaluedCount: 0,
    unsupportedReason: "Broker contract unavailable for ACME" });
});

test("a public/manual selection sharing broker metadata cannot inherit an unproven broker cache quote", () => {
  const f = fixture();
  f.tickers.get("ACME")!.metadata.positions[1] = { portfolio: "b", shares: 10, markPrice: 200, broker: "manual", currency: "USD" };
  const cached = new Map([["ACME", financials("ACME", 999)]]), tickers = [...f.tickers.values()];
  const publicInstrument = instrumentFromTicker(f.tickers.get("ACME"), "ACME", { portfolioId: "b" });
  expect(publicInstrument?.instrument).toBeNull();
  expect(buildPortfolioFinancialsMap(tickers, cached, new Map(), { portfolioId: "b" }).get("ACME")?.quote).toBeUndefined();
  const publicFinancials = financials("ACME", 200);
  expect(buildPortfolioFinancialsMap(tickers, cached, new Map([["ACME", publicFinancials]]), { portfolioId: "b" }).get("ACME")).toBe(publicFinancials);
  expect(buildPortfolioFinancialsMap(tickers, cached, new Map()).get("ACME")).toBe(cached.get("ACME"));
});

for (const startBlocked of [false, true]) test(`actual financial-map hook invalidates ${startBlocked ? "unresolved to public" : "public to unresolved"} identity`, async () => {
  const f = fixture();
  const make = (blocked: boolean): TickerRecord => ({ metadata: { ...f.tickers.get("ACME")!.metadata, broker_contracts: [], positions: [
    { portfolio: "b", shares: 10, broker: blocked ? "ibkr" : "manual", ...(blocked ? { brokerContractId: 999 } : {}) },
  ] } });
  f.coordinator.primeCachedFinancials([{ instrument: instrumentFromTicker(make(false), "ACME", { portfolioId: "b" })!, financials: financials("ACME", 100) }]);
  setSharedMarketDataCoordinator(f.coordinator);
  let replace!: (ticker: TickerRecord) => void;
  function HookHarness() {
    const [ticker, setTicker] = useState(make(startBlocked)); replace = setTicker;
    const map = useTickerFinancialsMap([ticker], { portfolioId: "b" });
    return <Text>{String(map.get("ACME")?.quote?.price ?? "unavailable")}</Text>;
  }
  await act(async () => { setup = await testRender(<HookHarness />, { width: 30, height: 3 }); }); await settleFrame(setup!, 20);
  expect(setup!.captureCharFrame()).toContain(startBlocked ? "unavailable" : "100");
  await act(async () => replace(make(!startBlocked))); await settleFrame(setup!, 20);
  expect(setup!.captureCharFrame()).toContain(startBlocked ? "100" : "unavailable");
});

test("actual PF rejects another account's symbol-only quote on a scoped cache miss", async () => {
  const f = fixture(false, "b");
  await render(f, "b", new Map([["ACME", financials("ACME", 999)]]), false, "portfolio-list");
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("2.0k"); expect(frame).toContain("50.00%"); expect(frame).not.toContain("10.0k");
});

test("actual Kelly uses scoped bankroll, current holding and price without research quote overriding them", async () => {
  await render(fixture(), "b", new Map([["ACME", financials("ACME", 999)]]), false, "kelly-sizer");
  const frame = setup!.captureCharFrame();
  expect(frame).toMatch(/Bankroll\s+4000\s+USD\s+Current\s+2000\s+USD/);
  expect(frame).toContain("$200.00"); expect(frame).toMatch(/Current %\s+50\.0%/);
  expect(frame).not.toContain("$999.00");
});

test("Kelly price label retains the scoped quote currency instead of the other account's research currency", async () => {
  const f = fixture(false, "b"), ticker = f.tickers.get("ACME")!;
  ticker.metadata.positions[1]!.currency = "EUR";
  ticker.metadata.broker_contracts![1]!.currency = "EUR";
  const scoped = financials("ACME", 200); scoped.quote!.currency = "EUR";
  f.coordinator.primeCachedFinancials([{ instrument: instrumentFromTicker(ticker, "ACME", { portfolioId: "b" })!, financials: scoped }]);
  await render(f, "b", new Map(), false, "kelly-sizer");
  expect(setup!.captureCharFrame()).toContain("€200.00");
  expect(setup!.captureCharFrame()).not.toContain("$200.00");
});
