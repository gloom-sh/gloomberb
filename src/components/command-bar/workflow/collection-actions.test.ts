import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { getPortfolioPositionMetrics, resolvePortfolioPositionPnl } from "../../../portfolio/position-metrics";
import { convertCurrency } from "../../../utils/format";
import type { Dispatch } from "react";
import { createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createDefaultConfig, type AppConfig } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerPosition, TickerRecord } from "../../../types/ticker";
import { EventBus } from "../../../plugins/event-bus";
import type { PluginRegistry } from "../../../plugins/registry";
import { createCommandBarCollectionWorkflowActions } from "./collection-actions";
import { createTestTicker } from "../../../test-support/ticker";
import { buildAddToPortfolioWorkflow, buildSetPortfolioPositionWorkflow } from "./portfolio-position";
import { loadFuturesContractTermsCached } from "../../../market-data/futures-contract";

function ticker(symbol: string, portfolios: string[] = []): TickerRecord {
  return createTestTicker(symbol, symbol, { portfolios });
}

function createHarness(initialTicker: TickerRecord, options: { config?: AppConfig; dataProvider?: Partial<DataProvider> } = {}) {
  const state: AppState = {
    ...createInitialState(options.config ?? createDefaultConfig(":memory:")),
    tickers: new Map([[initialTicker.metadata.ticker, initialTicker]]),
  };
  const order: string[] = [];
  const saved: TickerRecord[] = [];
  const payloads: Array<{ symbol: string; portfolioId: string }> = [];
  const events = new EventBus();
  const pluginRegistry = { events } as PluginRegistry;
  events.on("host:portfolio-ticker-saved", (payload) => {
    order.push("event");
    payloads.push(payload);
  });

  const actions = createCommandBarCollectionWorkflowActions({
    activeCollectionId: "main",
    activeTickerSymbol: initialTicker.metadata.ticker,
    dataProvider: (options.dataProvider ?? {}) as DataProvider,
    dispatch: ((action: AppAction) => {
      expect(action.type).toBe("UPDATE_TICKER");
      order.push("dispatch");
    }) as Dispatch<AppAction>,
    getState: () => state,
    notify: () => {},
    persistConfig: () => {},
    pluginRegistry,
    setActiveCollection: () => {},
    tickerRepository: {
      loadAllTickers: async () => [],
      loadTicker: async () => null,
      saveTicker: async (record) => {
        saved.push(record);
        order.push("save:start");
        await Promise.resolve();
        order.push("save:end");
      },
      createTicker: async () => initialTicker,
      deleteTicker: async () => {},
    },
  });

  return { actions, order, payloads, saved };
}

describe("command-bar collection workflow actions", () => {
  test("rejects empty acquisition cost before persistence while accepting an explicit zero", async () => {
    const { actions, order } = createHarness(ticker("AAPL"));
    for (const avgCost of ["", "  "]) {
      await expect(actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "AAPL", shares: "10", avgCost }))
        .rejects.toThrow("Avg Cost must be a valid number");
      expect(order).toEqual([]);
    }
    await actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "AAPL", shares: "10", avgCost: "0" });
    expect(order).toEqual(["save:start", "save:end", "dispatch", "event"]);
  });

  test("saving the position form unchanged keeps the total shares and cost basis of several lots", async () => {
    const lot = (shares: number, avgCost: number, dateAcquired: string): TickerPosition =>
      ({ portfolio: "main", broker: "manual", shares, avgCost, currency: "USD", dateAcquired });
    const holding = createTestTicker("AAPL", "Apple", {
      portfolios: ["main"],
      positions: [lot(10, 150, "2024-01-02"), lot(5, 170, "2024-06-03")],
    });
    const config = createDefaultConfig(":memory:");
    for (const form of [
      buildSetPortfolioPositionWorkflow(config, { activeCollectionId: "main", activeTicker: holding }),
      buildAddToPortfolioWorkflow(config, { preferredPortfolioId: "main", ticker: holding }),
    ]) {
      const { actions, saved } = createHarness(holding);

      await actions.setPortfolioPositionFromWorkflow(form!.values);

      const positions = saved[0]!.metadata.positions;
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({ portfolio: "main", broker: "manual", shares: 15, currency: "USD" });
      expect(positions[0]!.shares * positions[0]!.avgCost!).toBeCloseTo(10 * 150 + 5 * 170, 9);
    }
  });

  test("a future saves in contracts of its size, a cost typed as it is quoted in cents counts cents, and zero names contracts", async () => {
    // The form reads a future's terms where the portfolio does: oats are 5,000 bushels, quoted in US cents.
    await loadFuturesContractTermsCached("ZO=F", async (symbol) => ({
      symbol, root: "ZO", name: "Oats", contract: "ZOZ26", contractSymbol: "ZOZ26", deliveryMonth: "2026-12",
      spec: { unit: "US cents / bushel", size: "5,000 bushels", pointValue: 50, tick: 0.25, tickValue: 12.5, settlement: "physical" },
      lastTrade: null, firstNotice: null, inDelivery: false, settlement: null,
    }));
    const oats = createTestTicker("ZO=F", "Oats Dec 26", { exchange: "CBT", assetCategory: "FUTURE" });
    const { actions, saved } = createHarness(oats);
    // As the AP form fills it: the quote's price as the cost, the currency left blank.
    const form = buildAddToPortfolioWorkflow(createDefaultConfig(":memory:"), { preferredPortfolioId: "main", ticker: oats, quoteCurrency: "USX", defaultAvgCost: 350 })!;
    await actions.setPortfolioPositionFromWorkflow({ ...form.values, shares: "-3" });
    expect(saved[0]!.metadata.positions).toEqual([{ portfolio: "main", shares: -3, avgCost: 350, currency: "USX", broker: "manual", multiplier: 5000 }]);
    await expect(actions.setPortfolioPositionFromWorkflow({ ...form.values, shares: "0" })).rejects.toThrow("Contracts cannot be 0");
  });

  test("emits portfolio membership after the ticker is saved and dispatched", async () => {
    const { actions, order, payloads } = createHarness(ticker("AAPL"));

    await actions.addTickerMembershipFromWorkflow({
      portfolioId: "main",
      ticker: "AAPL",
    });

    expect(order).toEqual(["save:start", "save:end", "dispatch", "event"]);
    expect(payloads).toEqual([{ symbol: "AAPL", portfolioId: "main" }]);
  });

  test("emits portfolio membership when a resumed AP finds it already durable", async () => {
    const { actions, order, payloads } = createHarness(ticker("AAPL", ["main"]));

    await actions.addTickerMembershipFromWorkflow({
      portfolioId: "main",
      ticker: "AAPL",
    });

    expect(order).toEqual(["event"]);
    expect(payloads).toEqual([{ symbol: "AAPL", portfolioId: "main" }]);
  });
});

describe("the position form's Purchase Date and Cost FX, as position set --date and --cost-fx", () => {
  afterEach(() => { (apiClient.getCloudHistory as { mockRestore?: () => void }).mockRestore?.(); });
  /** A book valued in TRY, holding a lot in another stock, so the first position adopts nothing. */
  const lira = () => ({ ...createDefaultConfig(":memory:"), baseCurrency: "TRY" });
  // USD per unit, as the data provider gives a rate: 41.37 TRY per USD today.
  const rates = { getExchangeRate: async (code: string) => (code === "TRY" ? 1 / 41.37 : 1) };
  const aapl = (...positions: TickerPosition[]) => createTestTicker("AAPL", "Apple", { portfolios: ["main"], positions });
  const open = (record: TickerRecord, config = lira()) => buildSetPortfolioPositionWorkflow(config, { activeCollectionId: "main", activeTicker: record })!;
  const save = async (record: TickerRecord, values: Record<string, string>, config = lira()) => {
    const { actions, saved } = createHarness(record, { config, dataProvider: rates });
    await actions.setPortfolioPositionFromWorkflow({ ...open(record, config).values, ...values });
    return saved[0]!.metadata.positions.find((position) => position.portfolio === "main")!;
  };
  const buy = { shares: "10", avgCost: "410", currency: "USD" };

  test("a purchase date reads that day's FX close, a typed rate is checked against today's, and a rate needs a foreign holding", async () => {
    const history = spyOn(apiClient, "getCloudHistory").mockImplementation(async (symbol) => ({ status: "success",
      data: symbol === "TRY=X" ? [{ date: "2024-03-01T00:00:00.000Z", close: 31.3694 }] : [] }) as never);
    expect(await save(aapl(), { ...buy, dateAcquired: "1.3.2024" }))
      .toMatchObject({ dateAcquired: "2024-03-01", costFxRate: 31.3694, costFxCurrency: "TRY" });
    expect(history).toHaveBeenCalled();
    // A typed rate is the one paid, read with either decimal mark, and wins over the date's close.
    expect(await save(aapl(), { ...buy, dateAcquired: "2024-03-01", costFx: "32,15" })).toMatchObject({ dateAcquired: "2024-03-01", costFxRate: 32.15 });
    await expect(save(aapl(), { ...buy, costFx: "0.0319" })).rejects.toThrow(
      "Cost FX 0.0319 looks inverted: it is the TRY paid for one USD, and today's is 41.37 TRY per USD. Or give the Purchase Date, and its daily FX close is used.");
    await expect(save(aapl(), { ...buy, currency: "TRY", avgCost: "17000", costFx: "32" }))
      .rejects.toThrow("Cost FX converts a cost in another currency; AAPL is held in TRY, the portfolio's currency.");
    await expect(save(aapl(), { ...buy, dateAcquired: "2099-01-01" })).rejects.toThrow("Purchase Date 2099-01-01 is after today");
    history.mockResolvedValue({ status: "success", data: [] } as never);
    await expect(save(aapl(), { ...buy, dateAcquired: "2024-03-01" })).rejects.toThrow(
      "No TRY FX close in the week up to 2024-03-01, so the USD cost cannot be converted at the rate of 2024-03-01. Give the rate it was bought at in Cost FX instead, in TRY per USD.");
  });

  test("the form opens on the lot's date and rate: saved unchanged it keeps them, emptied it clears them", async () => {
    const history = spyOn(apiClient, "getCloudHistory");
    const held = aapl({ portfolio: "main", shares: 10, avgCost: 410, currency: "USD", broker: "manual", dateAcquired: "2024-03-01", costFxRate: 31.37, costFxCurrency: "TRY" });
    expect(open(held).values).toMatchObject({ dateAcquired: "2024-03-01", costFx: "31.37" });
    expect(await save(held, { shares: "12" })).toMatchObject({ shares: 12, dateAcquired: "2024-03-01", costFxRate: 31.37 });
    expect(history).not.toHaveBeenCalled();
    const cleared = await save(held, { costFx: "", dateAcquired: "" });
    expect(cleared.costFxRate).toBeUndefined();
    expect(cleared.dateAcquired).toBeUndefined();
  });

  test("lots bought at rates one position cannot keep are refused until the form gives its own", async () => {
    const lot = (shares: number, extra: Partial<TickerPosition> = {}): TickerPosition =>
      ({ portfolio: "main", shares, avgCost: 400, currency: "USD", broker: "manual", ...extra });
    const mixed = aapl(lot(10, { costFxRate: 31, costFxCurrency: "TRY" }), lot(20));
    expect(open(mixed).values.costFx).toBe("");
    await expect(save(mixed, {})).rejects.toThrow(
      "Of the 2 lots, 1 converts its cost at the FX rate it was bought at and 1 at today's, so one position cannot keep their rates. Give its Cost FX or Purchase Date.");
    expect(await save(mixed, { costFx: "33" })).toMatchObject({ shares: 30, costFxRate: 33 });
  });

  test("GBp round trip: a cost typed in pence is saved in pence, and its P&L divides it by 100", async () => {
    // GLO-1085: GBp was upper-cased to GBP, and 1,000 VOD at 70p cost £70,000 instead of £700.
    const config = { ...createDefaultConfig(":memory:"), baseCurrency: "GBP" };
    const vod = createTestTicker("VOD", "Vodafone", { exchange: "LSE", currency: "GBp", portfolios: ["main"] });
    const { actions, saved } = createHarness(vod, { config });
    await actions.setPortfolioPositionFromWorkflow({ ...open(vod, config).values, shares: "1000", avgCost: "70", currency: "GBp" });
    const record = saved[0]!;
    expect(record.metadata.positions).toEqual([{ portfolio: "main", shares: 1000, avgCost: 70, currency: "GBp", broker: "manual" }]);
    // As the PF pane values it in pounds, the quote (in pounds) at 72.5p.
    const fx = new Map([["USD", 1], ["GBP", 1.27]]);
    const metrics = getPortfolioPositionMetrics(record, "main", "GBP", { currency: "GBP", convert: (value, currency) => convertCurrency(value, currency, "GBP", fx) });
    expect(metrics.totalCost).toBeCloseTo(700, 9);
    expect(resolvePortfolioPositionPnl(metrics, 0.725).value).toBeCloseTo(25, 9);
  });
});
