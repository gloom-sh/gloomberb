import { describe, expect, test } from "bun:test";
import type { EarningsCalendarQuery, EarningsCalendarReport } from "../../../api-client/earnings";
import type { SupplyChainPayload } from "../../../api-client/supply-chain";
import { loadRipple } from "./client";

const chain = (symbol: string, customers: string[]): SupplyChainPayload => ({ symbol, says: customers.map((ticker) => ({
  role: "customer", counterparty: { ticker, name: ticker, exchange: "NASDAQ", aggregate: false },
  pctBasis: "revenue", pctOfRevenue: 10, pctScope: null, period: "2026-03-31",
})) } as SupplyChainPayload);
const report = (symbol: string, date = "2026-11-15"): EarningsCalendarReport =>
  ({ symbol, name: symbol, date, timing: "amc", averageMove: 0.025, averageReports: 8 } as EarningsCalendarReport);

describe("loadRipple", () => {
  test("a failing calendar after slow disclosures rejects once, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(loadRipple(["CRUS", "QRVO"], {
        supplyChain: async (symbol) => { await Bun.sleep(30); return chain(symbol, ["AAPL"]); },
        calendar: () => Promise.reject(new Error("calendar down")),
      })).rejects.toThrow("calendar down");
      await Bun.sleep(60);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("requests customers and holdings explicitly within the New York date window", async () => {
    const queries: EarningsCalendarQuery[] = [];
    const reports = [report("AAPL"), report("SMALL"), report("CRUS", "2026-11-20"), report("QRVO", "2026-11-21"), report("UNRELATED")];
    const snapshot = await loadRipple(["crus", "CRUS", "QRVO"], {
      supplyChain: async (symbol) => chain(symbol, symbol === "CRUS" ? ["AAPL", "SMALL"] : ["AAPL"]),
      calendar: async (query) => {
        queries.push(query);
        return { asOf: "2026-11-01", from: query.from, to: query.to, reports: reports.filter((row) => query.symbols?.includes(row.symbol)) };
      },
    }, new Date("2026-11-02T04:30:00Z")); // Still Nov 1 in New York, after the fall DST change.
    expect(queries).toEqual([{ from: "2026-11-01", to: "2026-12-01", perDay: 0, symbols: ["AAPL", "CRUS", "QRVO", "SMALL"] }]);
    expect([snapshot.from, snapshot.to]).toEqual(["2026-11-01", "2026-12-01"]);
    expect(snapshot.rows.map((row) => [row.holding, row.customer, row.holdingDate])).toEqual([
      ["CRUS", "AAPL", "2026-11-20"], ["CRUS", "SMALL", "2026-11-20"], ["QRVO", "AAPL", "2026-11-21"],
    ]);
  });

  test("merges symbol chunks and preserves stale status from the later chunk", async () => {
    const customers = Array.from({ length: 250 }, (_, index) => `C${String(index).padStart(3, "0")}`);
    const queries: EarningsCalendarQuery[] = [];
    const staleFlags: boolean[] = [];
    const reports = [...customers.map((symbol) => report(symbol)), report("HOLDING", "2026-11-20")];
    const snapshot = await loadRipple(["HOLDING"], {
      staleFlags,
      supplyChain: async (symbol) => chain(symbol, customers),
      calendar: async (query) => {
        queries.push(query);
        staleFlags.push(queries.length === 2);
        return { asOf: "2026-11-01", from: query.from, to: query.to, reports: reports.filter((row) => query.symbols?.includes(row.symbol)) };
      },
    }, new Date("2026-11-01T12:00:00Z"));
    expect(queries.map((query) => [query.perDay, query.symbols?.length])).toEqual([[0, 200], [0, 51]]);
    expect(queries.flatMap((query) => query.symbols ?? [])).toEqual([...customers, "HOLDING"]);
    expect(snapshot.rows).toHaveLength(250);
    expect(snapshot.rows.find((row) => row.customer === "C249")?.holdingDate).toBe("2026-11-20");
    expect(snapshot.stale).toBe(true);
  });

  test("skips the calendar without candidate customers and retains disclosure failures", async () => {
    let calendarCalls = 0;
    const snapshot = await loadRipple(["EMPTY", "FAILED"], {
      supplyChain: async (symbol) => {
        if (symbol === "FAILED") throw new Error("disclosures unavailable");
        return chain(symbol, []);
      },
      calendar: async (query) => {
        calendarCalls++;
        return { asOf: "2026-11-01", from: query.from, to: query.to, reports: [] };
      },
    });
    expect(calendarCalls).toBe(0);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.failures).toEqual([{ symbol: "FAILED", error: "disclosures unavailable" }]);
  });
});
