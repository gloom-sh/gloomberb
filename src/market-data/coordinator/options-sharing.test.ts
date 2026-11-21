import { expect, test } from "bun:test";
import { CachedQuery } from "../../data/cached-query";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { DataProvider } from "../../types/data-provider";
import type { OptionContract, OptionsChain } from "../../types/financials";
import { MarketDataCoordinator } from "./index";

const first = 1_800_000_000, second = first + 86400 * 7;
const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
const contract = (expiration: number): OptionContract => ({ contractSymbol: `call-${expiration}`, strike: 100, expiration,
  bid: 1, ask: 1.1, lastPrice: 1, openInterest: 10, volume: 1, impliedVolatility: 0.2,
  currency: "USD", change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: 1_790_000_000 });
const chain = (expiration = first): OptionsChain => ({ underlyingSymbol: "AAPL", expirationDates: [first, second],
  calls: [contract(expiration)], puts: [] });

test("a catalogue response aliases only its observed expiry, while refreshes preserve newer responses", async () => {
  const calls: (number | undefined)[] = [];
  let fail = false;
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    getOptionsChain: async (_symbol, _exchange, expiration) => {
      calls.push(expiration);
      if (fail) throw new Error("refresh failed");
      return chain(expiration);
    },
  }));
  const catalogue = await coordinator.loadOptions({ instrument });
  const explicit = await coordinator.loadOptions({ instrument, expirationDate: first });
  expect(explicit).toBe(catalogue);
  expect(coordinator.getOptionsEntry({ instrument, expirationDate: first })).toBe(catalogue);
  expect(calls).toEqual([undefined]);
  await coordinator.loadOptions({ instrument, expirationDate: second });
  expect(calls).toEqual([undefined, second]);
  const refreshed = await coordinator.loadOptions({ instrument, expirationDate: first }, { forceRefresh: true });
  expect(calls).toEqual([undefined, second, first]);
  expect(await coordinator.loadOptions({ instrument, expirationDate: first })).toBe(refreshed);
  fail = true;
  await coordinator.loadOptions({ instrument, expirationDate: first }, { forceRefresh: true });
  const retry = await coordinator.loadOptions({ instrument, expirationDate: first });
  expect(retry.error?.message).toBe("refresh failed");
  // The original loader retains a fresh last-good result and its active failure.
  expect(calls).toHaveLength(4);
});

test("concurrent catalogue and explicit requests share the default slice without leaking instrument scope", async () => {
  let release!: (value: OptionsChain) => void;
  const pending = new Promise<OptionsChain>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    getOptionsChain: async (symbol, exchange, expiration) => {
      calls.push(`${symbol}:${exchange}:${expiration ?? "default"}`);
      return expiration == null ? pending : chain(expiration);
    },
  }));
  const catalogue = coordinator.loadOptions({ instrument });
  const explicit = coordinator.loadOptions({ instrument, expirationDate: first });
  release(chain());
  await Promise.all([catalogue, explicit]);
  expect(calls).toEqual(["AAPL:NASDAQ:default"]);
  await coordinator.loadOptions({ instrument: { symbol: "AAPL", exchange: "LSE" }, expirationDate: first });
  expect(calls).toHaveLength(2);
});

// A long-lived app opens OMON on its stored catalogue and reads it again in
// the background: the expiry asked beside it built the same chain again.
test("the stored catalogue's expiry waits for its background refresh and reuses its slice, another is read beside it", async () => {
  const calls: (number | undefined)[] = [];
  let fail = false;
  let catalogueHeld: Promise<void> = Promise.resolve();
  const provider = createTestDataProvider({
    getOptionsChain: async (_symbol, _exchange, expiration) => {
      const failing = fail;
      calls.push(expiration);
      await Bun.sleep(1);
      if (expiration == null) await catalogueHeld;
      if (failing) throw new Error("refresh failed");
      return chain(expiration);
    },
  });
  const queries = new Map<string, CachedQuery<OptionsChain>>();
  provider.getCachedQuery = ((_method, args) => {
    const [symbol, exchange, expiration] = args as [string, string, number | undefined];
    const key = `${symbol}:${exchange}:${expiration ?? "default"}`;
    const now = Date.now();
    const stored = expiration == null ? { value: chain(), fetchedAt: now - 900_000, staleAt: now - 600_000, expiresAt: now + 3_600_000, source: "test-cache" } : null;
    if (!queries.has(key)) queries.set(key, new CachedQuery({ read: () => stored, fetch: async () => ({
      value: await provider.getOptionsChain!(symbol, exchange, expiration), fetchedAt: Date.now(),
      staleAt: Date.now() + 600_000, expiresAt: Date.now() + 3_600_000, source: "test-cache",
    }) }));
    return queries.get(key);
  }) as DataProvider["getCachedQuery"];
  const coordinator = new MarketDataCoordinator(provider);

  expect((await coordinator.loadOptions({ instrument })).phase).toBe("refreshing");
  const explicit = await coordinator.loadOptions({ instrument, expirationDate: first });
  expect(calls).toEqual([undefined]);
  expect(explicit.phase).toBe("ready");
  expect(explicit.data?.calls.map((contract) => contract.expiration)).toEqual([first]);
  // The live refresh still reads the expiry itself.
  await coordinator.loadOptions({ instrument, expirationDate: first }, { forceRefresh: true });
  expect(calls).toEqual([undefined, first]);

  // A background refresh that fails proves nothing: the expiry is read.
  fail = true;
  calls.length = 0;
  queries.clear();
  const failing = new MarketDataCoordinator(provider);
  await failing.loadOptions({ instrument });
  fail = false;
  await failing.loadOptions({ instrument, expirationDate: first });
  expect(calls).toEqual([undefined, first]);

  // Another expiry than the stored slice's is read beside the refresh, not after it.
  let release!: () => void;
  catalogueHeld = new Promise((resolve) => { release = resolve; });
  calls.length = 0;
  queries.clear();
  const beside = new MarketDataCoordinator(provider);
  await beside.loadOptions({ instrument });
  expect((await beside.loadOptions({ instrument, expirationDate: second })).data?.calls[0]?.expiration).toBe(second);
  expect(calls).toEqual([undefined, second]);
  release();
});

test("empty, mixed-expiry, unlisted or stale default slices never prove an explicit expiry", async () => {
  for (const input of [
    { ...chain(), calls: [] },
    { ...chain(), calls: [contract(first), contract(second)] },
    { ...chain(), expirationDates: [second] },
  ]) {
    let calls = 0;
    const coordinator = new MarketDataCoordinator(createTestDataProvider({ getOptionsChain: async () => { calls += 1; return input; } }));
    await coordinator.loadOptions({ instrument });
    await coordinator.loadOptions({ instrument, expirationDate: first });
    expect(calls).toBe(2);
  }
  let calls = 0;
  const coordinator = new MarketDataCoordinator(createTestDataProvider({ getOptionsChain: async () => { calls += 1; return chain(); } }));
  const cached = await coordinator.loadOptions({ instrument });
  cached.staleAt = Date.now() - 1;
  await coordinator.loadOptions({ instrument, expirationDate: first });
  expect(calls).toBe(2);
});
