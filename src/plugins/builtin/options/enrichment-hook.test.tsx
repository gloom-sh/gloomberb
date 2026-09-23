import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { buildOptionsKey } from "../../../market-data/selectors";
import { testRender } from "../../../renderers/opentui/test-utils";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain } from "../../../types/financials";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { useOptionsEnrichment } from "./enrichment";

const now = Date.UTC(2026, 8, 22, 14);
const first = Date.UTC(2026, 10, 20) / 1000;
const second = Date.UTC(2026, 11, 18) / 1000;
const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
const curve: YieldPoint[] = [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" }];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let restoreRates: (() => void) | undefined;
const realNow = Date.now;

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  restoreRates?.(); restoreRates = undefined;
  setSharedMarketDataCoordinator(null);
  Date.now = realNow;
});

function chain(expiration: number, mid = 2): OptionsChain {
  const contract = (side: string) => ({ contractSymbol: `${side}-${expiration}`, strike: 100, expiration,
    currency: "USD", bid: mid * 0.99, ask: mid * 1.01, lastPrice: mid, lastTradeDate: now / 1000,
    impliedVolatility: 0.3, openInterest: 100, volume: 1, change: 0, percentChange: 0, inTheMoney: false });
  return { underlyingSymbol: "AAPL", expirationDates: [first, second], calls: [contract("call")], puts: [contract("put")],
    asOf: "2026-09-22T13:45:00Z", providerId: "test" };
}
async function settle() {
  for (let index = 0; index < 3; index += 1) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
}

async function fixture(loadRates: () => Promise<YieldPoint[]>) {
  Date.now = () => now;
  const rateSpy = spyOn(apiClient, "getCloudYieldCurve").mockImplementation(loadRates);
  restoreRates = () => rateSpy.mockRestore();
  const requests: (number | undefined)[] = [];
  let nextSelectedResponse: Promise<OptionsChain> | null = null;
  const provider = { id: "test", getOptionsChain: async (_symbol: string, _exchange: string, expiration?: number) => {
    requests.push(expiration);
    if (expiration === first && nextSelectedResponse) return nextSelectedResponse;
    return chain(expiration ?? first);
  } } as unknown as DataProvider;
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  await coordinator.loadOptions({ instrument, expirationDate: first });
  await coordinator.loadOptions({ instrument, expirationDate: second });
  type Parameters = { expiration: number; catalogue: number[]; spot: number };
  let update!: (patch: Partial<Parameters>) => void;
  let resource!: ReturnType<typeof useOptionsEnrichment>;
  function Probe() {
    const [parameters, setParameters] = useState<Parameters>({ expiration: first, catalogue: [first, second], spot: 100 });
    update = (patch) => setParameters((previous) => ({ ...previous, ...patch }));
    const entry = coordinator.getOptionsEntry({ instrument, expirationDate: parameters.expiration });
    resource = useOptionsEnrichment({ ...parameters, instrument: { ...instrument }, catalogue: [...parameters.catalogue],
      // Cached coordinator projections may allocate new wrappers without accepting new data.
      selectedEntry: { ...entry, data: entry.data ? { ...entry.data } : null,
        lastGoodData: entry.lastGoodData ? { ...entry.lastGoodData } : null }, spotAsOf: now });
    return null;
  }
  await act(async () => { setup = await testRender(<Probe />, { width: 20, height: 5 }); });
  await settle();
  return { coordinator, rateSpy, requests, resource: () => resource,
    setResponse: (promise: Promise<OptionsChain>) => { nextSelectedResponse = promise; },
    update: async (patch: Partial<Parameters>) => { await act(async () => update(patch)); await settle(); } };
}

test("new projections and spot ticks do not reload analytics; an accepted same-time refresh does", async () => {
  const f = await fixture(async () => curve);
  expect(f.resource().snapshot!.expectedMove.straddle).toBe(4);
  expect(f.resource().snapshot!.phase).toBe("partial");
  expect(f.resource().loading).toBe(false);
  expect(f.rateSpy).toHaveBeenCalledTimes(1);
  for (let tick = 1; tick <= 5; tick += 1) await f.update({ spot: 100 + tick / 10 });
  await f.update({ catalogue: [second, first, first] });
  expect(f.rateSpy).toHaveBeenCalledTimes(1);
  expect(f.requests).toEqual([first, second]);
  expect(f.resource().snapshot!.spot).toBe(100);

  const gate = Promise.withResolvers<OptionsChain>();
  f.setResponse(gate.promise);
  const refreshed = f.coordinator.loadOptions({ instrument, expirationDate: first }, { forceRefresh: true });
  await f.update({ spot: 100.6 });
  expect(f.rateSpy).toHaveBeenCalledTimes(1);
  await act(async () => { gate.resolve(chain(first, 4)); await refreshed; });
  await f.update({ spot: 100.7 });
  // The refreshed slice reuses the daily Treasury curve its expiry already loaded.
  expect(f.rateSpy).toHaveBeenCalledTimes(1);
  expect(f.resource().snapshot!.expectedMove.straddle).toBe(8);
  expect(f.resource().snapshot!.spot).toBe(100.7);
  expect(f.resource().loading).toBe(false);
  expect(f.requests).toEqual([first, second, first]);
});

test("removal and expiry switches immediately hide old analytics and ignore their late completions", async () => {
  const removed = Promise.withResolvers<YieldPoint[]>();
  const superseded = Promise.withResolvers<YieldPoint[]>();
  let rateCalls = 0;
  const f = await fixture(() => {
    rateCalls += 1;
    return rateCalls === 1 ? removed.promise : rateCalls === 2 ? superseded.promise : Promise.resolve(curve);
  });
  expect(f.resource().snapshot!.expiration).toBe(first);
  expect(f.resource().loading).toBe(true);
  await f.update({ catalogue: [second] });
  expect(f.resource()).toMatchObject({ snapshot: null, loading: false });
  await act(async () => { removed.resolve(curve); }); await settle();
  expect(f.resource()).toMatchObject({ snapshot: null, loading: false });

  await f.update({ expiration: second, catalogue: [first, second] });
  expect(f.resource().snapshot!.expiration).toBe(second);
  expect(f.resource().loading).toBe(true);
  await f.update({ expiration: first });
  expect(f.resource().snapshot!.key).toBe(buildOptionsKey({ instrument, expirationDate: first }));
  expect(f.resource().loading).toBe(false);
  await act(async () => { superseded.resolve(curve); }); await settle();
  expect(f.resource().snapshot!.expiration).toBe(first);
  expect(f.resource().loading).toBe(false);
  expect(rateCalls).toBe(3);
});
