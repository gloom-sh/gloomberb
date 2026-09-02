import { describe, expect, test } from "bun:test";
import type { DataProvider, SearchRequestContext } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import { ProviderRouterSearchRoutes } from "./search";

function result(symbol: string, extra: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { symbol, name: symbol, exchange: "NASDAQ", type: "EQUITY", ...extra };
}

function provider(
  id: string,
  items: InstrumentSearchResult[],
  delayMs = 0,
): DataProvider {
  return {
    id,
    search: async () => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return items;
    },
  } as unknown as DataProvider;
}

function broker(
  id: string,
  items: InstrumentSearchResult[] | null,
  delayMs = 0,
) {
  return {
    brokerId: id,
    brokerInstanceId: `${id}-1`,
    brokerLabel: id,
    instance: {},
    broker: {
      searchInstruments: async () => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!items) throw new Error("broker down");
        return items;
      },
    },
  };
}

function makeRoutes(options: {
  brokers?: ReturnType<typeof broker>[];
  providers?: DataProvider[];
}) {
  return new ProviderRouterSearchRoutes({
    getBrokerCandidates: () => (options.brokers ?? []) as never,
    providersInPriorityOrder: () => options.providers ?? [],
    logProviderError: () => {},
  });
}

describe("provider search racing", () => {
  /**
   * The reason this exists: brokers used to be awaited one at a time before the
   * cloud was asked at all, so a single unreachable broker delayed every ticker
   * lookup in the app by its full timeout.
   */
  test("a hanging broker does not delay a provider that can answer", async () => {
    const routes = makeRoutes({
      brokers: [broker("dead", [result("NVDA")], 5_000)],
      providers: [provider("cloud", [result("NVDA")])],
    });

    const started = Date.now();
    const results = await routes.search("nvidia", { preferBroker: true, interactive: true });

    expect(results.map((item) => item.symbol)).toEqual(["NVDA"]);
    // Sequentially this waited on the broker's timeout first.
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("interactive lookups abandon a stalled source in well under a second", async () => {
    const routes = makeRoutes({ providers: [provider("slow", [result("AAPL")], 5_000)] });

    const started = Date.now();
    const results = await routes.search("apple", { interactive: true });

    expect(results).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("a broker that answers after the cloud upgrades the row in place", async () => {
    const partials: InstrumentSearchResult[][] = [];
    const routes = makeRoutes({
      brokers: [broker("ibkr", [result("NVDA", { brokerContract: { brokerId: "ibkr" } as never })], 60)],
      providers: [provider("cloud", [result("NVDA")])],
    });

    const first = await routes.search("nvidia", {
      preferBroker: true,
      interactive: true,
      onPartial: (items) => partials.push(items),
    });

    // The cloud answers immediately and that is what the caller renders.
    expect(first.map((item) => item.symbol)).toEqual(["NVDA"]);
    expect(first[0]?.brokerContract).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 200));

    // The broker's richer copy replaces it without duplicating the symbol.
    expect(partials).toHaveLength(1);
    expect(partials[0]).toHaveLength(1);
    expect(partials[0]?.[0]?.brokerContract).toBeDefined();
  });

  /**
   * Racing everything would bill a metered fallback on every keystroke for an
   * answer already in hand, so the second tier only runs when the first found
   * nothing.
   */
  test("a fallback provider is not asked when the preferred one answers", async () => {
    let fallbackCalls = 0;
    const fallback = {
      id: "fallback",
      search: async () => {
        fallbackCalls += 1;
        return [result("WRONG")];
      },
    } as unknown as DataProvider;
    const routes = makeRoutes({ providers: [provider("preferred", [result("NVDA")]), fallback] });

    const results = await routes.search("nvidia", { interactive: true });

    expect(results.map((item) => item.symbol)).toEqual(["NVDA"]);
    expect(fallbackCalls).toBe(0);
  });

  test("a fallback provider is asked when the preferred one finds nothing", async () => {
    let fallbackCalls = 0;
    const fallback = {
      id: "fallback",
      search: async () => {
        fallbackCalls += 1;
        return [result("NVDA")];
      },
    } as unknown as DataProvider;
    const routes = makeRoutes({ providers: [provider("preferred", []), fallback] });

    const results = await routes.search("nvidia", { interactive: true });

    expect(results.map((item) => item.symbol)).toEqual(["NVDA"]);
    expect(fallbackCalls).toBe(1);
  });

  test("a failing broker leaves the provider result intact", async () => {
    const routes = makeRoutes({
      brokers: [broker("dead", null)],
      providers: [provider("cloud", [result("MSFT")])],
    });

    const results = await routes.search("microsoft", { preferBroker: true });
    expect(results.map((item) => item.symbol)).toEqual(["MSFT"]);
  });

  test("concurrent identical queries share one run", async () => {
    let calls = 0;
    const counting = {
      id: "cloud",
      search: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [result("TSLA")];
      },
    } as unknown as DataProvider;
    const routes = makeRoutes({ providers: [counting] });

    const [a, b] = await Promise.all([routes.search("tesla"), routes.search("tesla")]);

    expect(a.map((item) => item.symbol)).toEqual(["TSLA"]);
    expect(b.map((item) => item.symbol)).toEqual(["TSLA"]);
    expect(calls).toBe(1);
  });

  test("results returned to one caller are not mutated by a later source", async () => {
    const routes = makeRoutes({
      brokers: [broker("late", [result("AMD")], 50)],
      providers: [provider("cloud", [result("NVDA")])],
    });

    const first = await routes.search("chips", { preferBroker: true } as SearchRequestContext);
    expect(first).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // The array handed back stays the answer that was handed back.
    expect(first).toHaveLength(1);
  });
});
