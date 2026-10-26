import { describe, expect, test } from "bun:test";
import type { ScannerFlowEvent, ScannerFlowPayload, ScannerHiloPayload } from "../../../api-client";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createFlowHeadless, createHiloHeadless, FLOW_SIDE_RULE, loadHiloSnapshot } from "./headless";

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

const ctx = { signal: new AbortController().signal } as HeadlessPaneContext;

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

    const result = await headless.load(args("1", "recent"), ctx);

    expect(result.errors).toEqual(["Scanner feed degraded"]);
  });

  test("applies the pane price and sort options to a stream snapshot", async () => {
    const headless = createHiloHeadless({ load: async () => payload });
    const filtered = await headless.load(args("1", "recent"), ctx);
    const unfiltered = await headless.load(args("off", "count"), ctx);

    expect(filtered.items.map((row) => row.symbol)).toEqual(["LOW", "HIGH"]);
    expect(unfiltered.items.map((row) => row.symbol)).toEqual(["PENNY", "LOW", "HIGH"]);
    expect((filtered.metadata?.windows as Array<Record<string, unknown>>)[0]).toMatchObject({
      key: "m5", highs: 3, lows: 3,
    });
  });
});

describe("options flow report", () => {
  const AT = Date.parse("2026-10-26T15:00:00Z");
  const print = (id: string, underlying: string, at: number): ScannerFlowEvent => ({
    id, at, underlying, contract: `${underlying}261030C00200000`, right: "C", strike: 200, expiry: "2026-10-30",
    side: "ask", kind: "sweep", size: 500, price: 10, premium: 500_000, volume: 1_000, openInterest: 500, volOi: 2, iv: 0.5,
  });
  const feed: ScannerFlowPayload = {
    status: "live", access: "realtime", delayMinutes: 0, asOf: AT, events: [print("live-nvda", "NVDA", AT), print("live-amd", "AMD", AT)],
  };
  const searches: string[] = [];
  const headless = createFlowHeadless({
    load: async () => feed,
    recorded: async (search) => { searches.push(`history?${search}`); return { events: [print("old-nvda", "NVDA", AT - 3_600_000)], hasMore: true }; },
    session: async (search) => {
      searches.push(`session?${search}`);
      return {
        session: "2026-10-26", bucketMs: 300_000,
        buckets: [
          { at: AT - 600_000, callAsk: 1_000_000, callBid: 0, putAsk: 0, putBid: 0 },
          { at: AT, callAsk: 0, callBid: 0, putAsk: 300_000, putBid: 0 },
        ],
        strikes: search.includes("symbol=") ? [{ expiry: "2026-10-30", strike: 200, callPremium: 1_000_000, putPremium: 300_000,
          callAsk: 1_000_000, callBid: 0, putAsk: 0, putBid: 0, prints: 3 }] : null,
      };
    },
  });
  const args = (argument: string | null, options: Record<string, string> = {}) =>
    ({ rawArgument: argument ?? "", argument, symbols: argument ? [argument] : [], options: { minPremium: "250000", ...options } });

  test("one name: its live and recorded prints, its tide and its strikes, with the side rule once", async () => {
    searches.length = 0;
    const report = await headless.load(args("nvda"), ctx);
    expect(searches).toEqual([
      "history?limit=100&minPremium=250000&universe=symbols&symbols=NVDA",
      "session?minPremium=250000&symbol=NVDA",
    ]);
    expect(report.sections.map((section) => section.title)).toEqual([
      "NVDA prints", "Net premium through the 2026-10-26 session", "NVDA by expiry and strike, 2026-10-26",
    ]);
    const [prints, tide, strikes] = report.sections as Array<{ rows: Array<Record<string, unknown>> }>;
    expect(prints!.rows.map((row) => row.id)).toEqual(["live-nvda", "old-nvda"]);
    // Newest first, each bucket with the running net premium through it.
    expect(tide!.rows.map((row) => [row.change, row.net])).toEqual([[-300_000, 700_000], [1_000_000, 1_000_000]]);
    expect(strikes!.rows[0]).toMatchObject({ strike: 200, net: 1_000_000 });
    expect(report.notes).toEqual([FLOW_SIDE_RULE]);
  });

  test("a session or recorded read that fails leaves the live prints standing, said under errors", async () => {
    const failing = createFlowHeadless({
      load: async () => feed,
      recorded: async () => { throw new Error("Request timed out"); },
      session: async () => { throw new Error("Not Found"); },
    });
    const market = await failing.load(args(null), ctx);
    expect(market.sections.map((section) => section.title)).toEqual(["Prints"]);
    expect(market.errors).toEqual(["Session totals unavailable: Not Found"]);
    expect(market.notes).toBeUndefined();
    const nvda = await failing.load(args("NVDA"), ctx);
    expect((nvda.sections[0] as { rows: Array<{ id: string }> }).rows.map((row) => row.id)).toEqual(["live-nvda"]);
    expect(nvda.errors).toEqual(["Recorded prints unavailable: Request timed out", "Session totals unavailable: Not Found"]);
    // Asked for the sums alone, there is nothing left to report.
    await expect(failing.load(args(null, { tab: "tide" }), ctx)).rejects.toThrow("Session totals unavailable");
  });

  test("the market reads the live tape alone, a tab one section, and strikes need a ticker", async () => {
    searches.length = 0;
    const market = await headless.load(args(null, { tab: "prints" }), ctx);
    expect(searches).toEqual([]);
    expect(market.sections).toHaveLength(1);
    expect(market.notes).toBeUndefined();
    expect((market.sections[0] as { rows: unknown[] }).rows).toHaveLength(2);
    await expect(headless.load(args(null, { tab: "strikes" }), ctx)).rejects.toThrow("needs a ticker");
  });
});
