import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../test-support/data-provider";
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
