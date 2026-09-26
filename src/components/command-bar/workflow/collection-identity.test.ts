import { expect, test } from "bun:test";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { TickerMetadata, TickerRecord } from "../../../types/ticker";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { resolveTickerOpenTarget } from "../../../tickers/open-target";
import { EventBus } from "../../../plugins/event-bus";
import type { PluginRegistry } from "../../../plugins/registry";
import { executeCollectionCommandAction } from "../commands/collection";
import type { CollectionCommandId } from "../helpers";
import { createCommandBarCollectionWorkflowActions } from "./collection-actions";
import { resolveCollectionTicker, AmbiguousCollectionTickerError } from "./collection-ticker";
import type { SharedWorkflowDeps } from "./tickers";

function holding(ticker = "ASML", patch: Partial<TickerMetadata> = {}): TickerRecord {
  return { metadata: {
    ticker, name: ticker, exchange: "NASDAQ", currency: "USD", assetCategory: "Depositary Receipt",
    portfolios: ["main"], watchlists: ["watchlist"],
    positions: [{ portfolio: "main", shares: 10, avgCost: 500, currency: "USD", broker: "manual" }],
    tags: [], custom: {}, ...patch,
  } };
}

async function harness(saved = holding(), query = "ASML:XNAS") {
  const storage = new Map<string, string>();
  const tickerRepository = new JsonTickerRepository({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  });
  await tickerRepository.saveTicker(saved);
  const state = createInitialState(createDefaultConfig(":memory:"));
  state.config.portfolios.push({ id: "other", name: "Other", currency: "USD" });
  state.tickers.set(saved.metadata.ticker, saved);
  const dataProvider = createTestDataProvider();
  const research = (await resolveTickerOpenTarget({ query, tickers: state.tickers, dataProvider, tickerRepository }))!;
  expect(research).not.toBeNull();
  expect(research.ticker.metadata.positions).toEqual([]);
  state.tickers.set(research.symbol, research.ticker);
  const writes: string[] = [];
  const originalSave = tickerRepository.saveTicker.bind(tickerRepository);
  tickerRepository.saveTicker = async (ticker) => { writes.push(ticker.metadata.ticker); await originalSave(ticker); };
  const deps: SharedWorkflowDeps = {
    tickerRepository, dataProvider, pluginRegistry: { events: new EventBus() } as PluginRegistry,
    getState: () => state,
    dispatch: (action) => { if (action.type === "UPDATE_TICKER") state.tickers.set(action.ticker.metadata.ticker, action.ticker); },
  };
  const notices: Array<{ body: string; type?: string }> = [];
  const opened: Array<{ ticker: TickerRecord; target?: string | null }> = [];
  const routes: unknown[] = [];
  const command = (commandId: CollectionCommandId, target?: string, selectedTicker?: TickerRecord) => executeCollectionCommandAction({
    commandId, rawInput: query, selectedTicker, explicitTargetId: target,
    activeCollectionId: "other", activeTickerSymbol: research.symbol,
    getState: deps.getState, buildWorkflowDeps: () => deps,
    openModeRoute: (...args) => { routes.push(args); }, pushRoute: (route) => { routes.push(route); },
    openAddToPortfolioWorkflow: (ticker, preferredPortfolioId) => { opened.push({ ticker, target: preferredPortfolioId }); },
    notify: (body, options) => { notices.push({ body, type: options?.type }); }, closeAll: () => {},
  });
  const actions = createCommandBarCollectionWorkflowActions({
    ...deps, activeCollectionId: "other", activeTickerSymbol: research.symbol,
    notify: () => {}, persistConfig: () => {}, setActiveCollection: () => {},
  });
  return { saved, storedSaved: await tickerRepository.loadTicker(saved.metadata.ticker), research, state, tickerRepository, writes, notices, opened, routes, command, actions };
}

test("typed and selected collection commands reach the existing owner after research created an empty venue key", async () => {
  for (const selected of [false, true]) {
    const h = await harness();
    const amsterdam = holding("ASML:XAMS", { exchange: "AMS", currency: "EUR", assetCategory: "Common Stock" });
    await h.tickerRepository.saveTicker(amsterdam);
    const amsterdamBefore = await h.tickerRepository.loadTicker("ASML:XAMS");
    h.state.tickers.set(amsterdam.metadata.ticker, amsterdam);
    h.writes.length = 0;
    const researchBefore = structuredClone(h.research.ticker);
    await h.command("add-portfolio", "main", selected ? h.research.ticker : undefined);
    expect(h.opened).toEqual([{ ticker: h.saved, target: "main" }]);
    expect(h.opened[0]!.ticker.metadata.positions[0]!.shares).toBe(10);
    await h.command("remove-portfolio", "main", selected ? h.research.ticker : undefined);
    expect((await h.tickerRepository.loadTicker("ASML"))?.metadata).toMatchObject({ portfolios: [], positions: [] });
    expect(await h.tickerRepository.loadTicker("ASML:XNAS")).toEqual(researchBefore);
    expect(await h.tickerRepository.loadTicker("ASML:XAMS")).toEqual(amsterdamBefore);
    expect(h.writes).toEqual(["ASML"]);
    expect(h.routes).toEqual([]);
  }
});

test("portfolio forms update the selected portfolio owner without duplicating research aliases", async () => {
  for (const [assetCategory, portfolios] of [
    ["Depositary Receipt", []], ["Depositary Receipt", ["main"]],
    ["Common Stock", []], ["Common Stock", ["main"]],
  ] as const) {
    const h = await harness(holding("ASML", { assetCategory, portfolios: [...portfolios] }));
    await h.actions.addTickerMembershipFromWorkflow({ portfolioId: "main", ticker: "ASML:XNAS" });
    expect(h.writes).toEqual(portfolios.length ? [] : ["ASML"]);
    h.writes.length = 0;
    await h.actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "ASML:XNAS", shares: "12", avgCost: "550" });
    expect(h.writes).toEqual(["ASML"]);
    expect((await h.tickerRepository.loadTicker("ASML"))?.metadata.positions)
      .toEqual([{ portfolio: "main", shares: 12, avgCost: 550, currency: "USD", broker: "manual" }]);
    expect((await h.tickerRepository.loadTicker("ASML:XNAS"))?.metadata).toMatchObject({ positions: [], portfolios: [] });
  }
});

test("watchlist commands reuse the existing membership for exchange and Yahoo aliases", async () => {
  for (const query of ["VOD:XLON", "VOD.L"]) {
    const h = await harness(holding("VOD", { exchange: "LSE", currency: "GBP" }), query);
    await h.command("add-watchlist", "watchlist");
    expect(h.writes).toEqual([]);
    await h.command("remove-watchlist", "watchlist");
    expect(h.writes).toEqual(["VOD"]);
    expect((await h.tickerRepository.loadTicker("VOD"))?.metadata.watchlists).toEqual([]);
    expect((await h.tickerRepository.loadTicker(query))?.metadata.watchlists).toEqual([]);
  }
});

test("competing owners in the requested portfolio stop both commands and forms before persistence", async () => {
  const h = await harness();
  const competing = holding("ASML:XNAS");
  h.state.tickers.set("ASML:XNAS", competing);
  await h.tickerRepository.saveTicker(competing);
  const competingBefore = await h.tickerRepository.loadTicker("ASML:XNAS");
  h.writes.length = 0;
  await h.command("remove-portfolio", "main");
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]!.type).toBe("error");
  expect(h.notices[0]!.body).toContain("Multiple saved records");
  await h.command("remove-watchlist", "watchlist");
  expect(h.notices).toHaveLength(2);
  expect(h.notices[1]!.type).toBe("error");
  await expect(h.actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "ASML:XNAS", shares: "12", avgCost: "550" }))
    .rejects.toBeInstanceOf(AmbiguousCollectionTickerError);
  await expect(h.actions.addTickerMembershipFromWorkflow({ portfolioId: "main", ticker: "ASML:XNAS" }))
    .rejects.toBeInstanceOf(AmbiguousCollectionTickerError);
  expect(h.writes).toEqual([]);
  expect(await h.tickerRepository.loadTicker("ASML")).toEqual(h.storedSaved);
  expect(await h.tickerRepository.loadTicker("ASML:XNAS")).toEqual(competingBefore);
});

test("selected portfolio scope disambiguates records that own different portfolios", async () => {
  const h = await harness();
  const otherOwner = holding("ASML:XNAS", { portfolios: ["other"], positions: [{ portfolio: "other", shares: 30, avgCost: 400, broker: "manual", currency: "USD" }] });
  h.state.tickers.set("ASML:XNAS", otherOwner);
  await h.tickerRepository.saveTicker(otherOwner);
  const otherBefore = await h.tickerRepository.loadTicker("ASML:XNAS");
  h.writes.length = 0;
  await h.actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "ASML:XNAS", shares: "12", avgCost: "550" });
  expect(h.writes).toEqual(["ASML"]);
  expect(await h.tickerRepository.loadTicker("ASML:XNAS")).toEqual(otherBefore);
  await h.actions.setPortfolioPositionFromWorkflow({ portfolioId: "other", ticker: "ASML", shares: "32", avgCost: "450" });
  expect(h.writes).toEqual(["ASML", "ASML:XNAS"]);
  expect((await h.tickerRepository.loadTicker("ASML:XNAS"))?.metadata.positions[0]?.shares).toBe(32);
});

test("collection identity requires a consistent venue and currency and never aliases derivative contracts", () => {
  const saved = holding();
  const empty = { portfolios: [], watchlists: [], positions: [] };
  for (const patch of [
    { exchange: "AMS", currency: "EUR" },
    { currency: "EUR" },
    { assetCategory: "BOND" },
    { assetCategory: "FUT" },
    { broker_contracts: [{ brokerId: "ibkr", brokerInstanceId: "paper", secType: "OPT", conId: 55, strike: 600, right: "C" }] },
  ]) {
    const candidate = holding("ASML:NASDAQ", { ...empty, ...patch });
    // Explicit symbol venue is authoritative, so vary both for the other listing.
    if (patch.exchange === "AMS") candidate.metadata.ticker = "ASML:XAMS";
    const records = new Map([["ASML", saved], [candidate.metadata.ticker, candidate]]);
    expect(resolveCollectionTicker(candidate, records, "portfolio", "main")).toBe(candidate);
  }
  const unknown = holding("ASML", { ...empty, exchange: "" });
  expect(resolveCollectionTicker(unknown, new Map([["ASML:XNAS", holding("ASML:XNAS")]]), "portfolio", "main")).toBe(unknown);
  const mismatchedSuffix = holding("ASML.AS", { ...empty, exchange: "NASDAQ" });
  expect(resolveCollectionTicker(mismatchedSuffix, new Map([["ASML", saved]]), "portfolio", "main")).toBe(mismatchedSuffix);
});

test("stale search selections use the current stored membership without overwriting it", () => {
  const selected = holding("ASML:XNAS", { portfolios: [], positions: [] });
  const current = holding("ASML:XNAS");
  expect(resolveCollectionTicker(selected, new Map([["ASML:XNAS", current]]), "portfolio", "main")).toBe(current);
});
