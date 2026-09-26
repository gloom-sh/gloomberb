import { describe, expect, test } from "bun:test";
import type { ScannerHiloPayload } from "../../../api-client";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createHiloHeadless, loadHiloSnapshot } from "./headless";

const payload: ScannerHiloPayload = {
  status: "live",
  asOf: 123,
  access: "realtime",
  delayMinutes: 0,
  windows: { s30: { highs: 1, lows: 1 }, m1: { highs: 2, lows: 2 }, m5: { highs: 3, lows: 3 } },
  lows: [
    { symbol: "PENNY", price: 0.5, count: 10, at: 10 },
    { symbol: "LOW", price: 10, count: 2, at: 20 },
  ],
  highs: [{ symbol: "HIGH", price: 20, count: 5, at: 30 }],
};

function args(minPrice: string, sort: string): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: { minPrice, sort } };
}

describe("highs and lows headless model", () => {
  test("waits for scanner data beyond the connecting snapshot", async () => {
    let unsubscribed = 0;
    const result = await loadHiloSnapshot({
      subscribeScanner(_scanner, listener) {
        listener({ type: "data", payload: { ...payload, status: "starting" } });
        listener({ type: "data", payload });
        return () => { unsubscribed += 1; };
      },
    }, new AbortController().signal);

    expect(result.status).toBe("live");
    expect(unsubscribed).toBe(1);
  });

  test("a stale row on the way to live does not end the wait", async () => {
    const result = await loadHiloSnapshot({
      subscribeScanner(_scanner, listener) {
        listener({ type: "data", payload: { ...payload, status: "degraded", asOf: 1 } });
        listener({ type: "data", payload: { ...payload, status: "starting" } });
        listener({ type: "data", payload });
        return () => {};
      },
    }, new AbortController().signal);
    expect(result).toMatchObject({ status: "live", asOf: 123 });

    // A feed that never recovers still answers, flagged, at the deadline.
    const stuck = await loadHiloSnapshot({
      subscribeScanner(_scanner, listener) {
        listener({ type: "data", payload: { ...payload, status: "degraded" } });
        return () => {};
      },
    }, new AbortController().signal, 5);
    expect(stuck.status).toBe("degraded");
  });

  test("reports a degraded stream as partial data", async () => {
    const headless = createHiloHeadless({
      load: async () => ({ ...payload, status: "degraded" }),
    });

    const result = await headless.load(args("1", "recent"), {} as HeadlessPaneContext);

    expect(result.errors).toEqual(["Scanner feed degraded"]);
  });

  test("applies the pane price and sort options to a stream snapshot", async () => {
    const headless = createHiloHeadless({ load: async () => payload });
    const filtered = await headless.load(args("1", "recent"), {} as HeadlessPaneContext);
    const unfiltered = await headless.load(args("off", "count"), {} as HeadlessPaneContext);

    expect(filtered.items.map((row) => row.symbol)).toEqual(["LOW", "HIGH"]);
    expect(unfiltered.items.map((row) => row.symbol)).toEqual(["PENNY", "LOW", "HIGH"]);
    expect((filtered.metadata?.windows as Array<Record<string, unknown>>)[0]).toMatchObject({
      key: "m5", highs: 3, lows: 3,
    });
  });
});
