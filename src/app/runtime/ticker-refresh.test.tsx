import { useRegularMarketSession } from "../../test-support/market-session";
import { expect, test } from "bun:test";
import { act, useState } from "react";
import type { PluginRegistry } from "../../plugins/registry";
import { MarketDataCoordinator } from "../../market-data/coordinator";
import type { InstrumentRef } from "../../market-data/request-types";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/pane";
import { testRender } from "../../renderers/opentui/test-utils";
import type { TickerFinancials } from "../../types/financials";
import { useTickerRefreshRuntime, type AppTickerRefreshRuntime } from "./ticker-refresh";

useRegularMarketSession();

const contracts = [101, 202].map((conId) => ({ brokerId: "ibkr", brokerInstanceId: "same", conId, symbol: "DUAL" }));
const targets: InstrumentRef[] = contracts.map((instrument) => ({ symbol: "DUAL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "same", instrument }));
const publicTarget: InstrumentRef = { symbol: "DUAL", exchange: "NASDAQ", instrument: null };
const ticker = createTestTicker("DUAL", "Controlled", { broker_contracts: contracts });
function financials(price: number): TickerFinancials {
  return { quote: { symbol: "DUAL", price, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() }, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
}

async function fixture() {
  const calls: Array<[string, number | null]> = [];
  const actions: Array<{ symbol: string; refreshing: boolean }> = [];
  const provider = createTestDataProvider({
    getTickerFinancials: async (_symbol, _exchange, context) => {
      const id = context?.instrument?.conId ?? null;
      calls.push(["financials", id]);
      return financials(id === 101 ? 110 : id === 202 ? 220 : 50);
    },
    getQuote: async (_symbol, _exchange, context) => {
      const id = context?.instrument?.conId ?? null;
      calls.push(["quote", id]);
      return financials(id === 101 ? 111 : id === 202 ? 221 : 51).quote!;
    },
  });
  const coordinator = new MarketDataCoordinator(provider);
  let runtime!: AppTickerRefreshRuntime;
  let activate!: () => void;
  function Harness() {
    const [active, setActive] = useState(false);
    activate = () => setActive(true);
    runtime = useTickerRefreshRuntime({ appVisible: active, baseCurrency: "USD", marketData: coordinator,
      pluginRegistry: { events: { emit: () => {} } } as unknown as PluginRegistry,
      dispatch: (action) => { if (action.type === "SET_REFRESHING") actions.push(action); }, tickers: new Map([["DUAL", ticker]]) });
    return null;
  }
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => { setup = await testRender(<Harness />, { width: 48, height: 12 }); });
  return { coordinator, calls, actions, runtime: () => runtime, activate,
    flush: async () => { await act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }); },
    close: async () => { await act(async () => setup.renderer.destroy()); coordinator.destroy(); } };
}

test("cached startup entries prime their exact broker/public target without rebuilding ticker priority", async () => {
  const f = await fixture();
  try {
    f.runtime().primeCachedFinancials([{ ticker, instrument: targets[1]!, financials: financials(220) }, { ticker, instrument: publicTarget, financials: financials(50) }]);
    expect(f.coordinator.getQuoteEntry(targets[0]!).data).toBeNull();
    expect(f.coordinator.getQuoteEntry(targets[1]!).data?.price).toBe(220);
    expect(f.coordinator.getQuoteEntry(publicTarget).data?.price).toBe(50);
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test("paused startup batches dedupe by instrument and retain both scopes through warmup", async () => {
  const f = await fixture();
  try {
    const entries = targets.map((instrument) => ({ ticker, instrument, priority: 2 }));
    f.runtime().refreshTickersBatch([...entries, { ...entries[0]!, priority: 0 }]);
    f.runtime().refreshTickersBatch(entries);
    f.runtime().refreshQuotesBatch(entries);
    expect(f.calls).toEqual([]);
    await act(async () => f.activate());
    await f.flush();
    expect(f.calls).toEqual([["financials", 101], ["financials", 202]]);
    expect(targets.map((target) => f.coordinator.getQuoteEntry(target).data?.price)).toEqual([110, 220]);
    expect(f.actions.filter(({ refreshing }) => !refreshing)).toHaveLength(1);
    expect(f.actions.at(-1)?.refreshing).toBe(false);
    f.runtime().refreshQuotesBatch(entries);
    await f.flush();
    // Batch quote warmup retains its existing fresh-cache policy.
    expect(f.calls.slice(2)).toEqual([]);
    expect(targets.map((target) => f.coordinator.getQuoteEntry(target).data?.price)).toEqual([110, 220]);
  } finally { await f.close(); }
});

test("cold quote batches retain separate broker/public scopes and existing ticker-only callers", async () => {
  const f = await fixture();
  try {
    f.runtime().refreshQuotesBatch([...targets, publicTarget].map((instrument) => ({ ticker, instrument, priority: 0 })).concat([{ ticker, priority: 0 }]));
    await act(async () => f.activate());
    await f.flush();
    expect(f.calls).toEqual([["quote", 101], ["quote", 202], ["quote", null]]);
    expect([...targets, publicTarget].map((target) => f.coordinator.getQuoteEntry(target).data?.price)).toEqual([111, 221, 51]);
  } finally { await f.close(); }
});

test("scalar warmups suppress duplicate work only for the same target and retain public requests", async () => {
  const f = await fixture();
  try {
    f.runtime().refreshTicker("DUAL", "NASDAQ", ticker, 0, targets[0]);
    f.runtime().refreshTicker("DUAL", "NASDAQ", ticker, 0, targets[0]);
    f.runtime().refreshQuote("DUAL", "NASDAQ", ticker, 0, targets[0]);
    f.runtime().refreshQuote("DUAL", "NASDAQ", ticker, 0, targets[1]);
    f.runtime().refreshQuote("DUAL", "NASDAQ", ticker, 0, publicTarget);
    await act(async () => f.activate());
    await f.flush();
    expect(f.calls).toEqual([["financials", 101], ["quote", 202], ["quote", null]]);
    expect(f.coordinator.getQuoteEntry(targets[0]!).data?.price).toBe(110);
    expect(f.coordinator.getQuoteEntry(targets[1]!).data?.price).toBe(221);
    expect(f.coordinator.getQuoteEntry(publicTarget).data?.price).toBe(51);
  } finally { await f.close(); }
});
