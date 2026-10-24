import { describe, expect, test } from "bun:test";
import type { TickerHolderRow, TickerHoldings } from "../thirteenf/signals";
import { indexedHolderPage, indexedHoldersPartialNote, indexHolderTicker, loadIndexedHolders, type IndexedHolderClient } from "./index-holders";

function row(cik: string, overrides: Partial<TickerHolderRow> = {}): TickerHolderRow {
  return {
    id: `${cik}:one`, cik, fund: `Fund ${cik}`, ticker: "AAA", cusip: "000000001", issuer: "A", type: "SH",
    value: 100, shares: 10, previousShares: 8, weight: null, previousWeight: null, weightChange: null, action: "add",
    ...overrides,
  };
}

function holdings(rows: TickerHolderRow[], overrides: Partial<TickerHoldings> = {}): TickerHoldings {
  return {
    ticker: "AAA", quarter: "2026Q2", period: "2026-06-30", previousPeriod: "2026-03-31", warnings: [], asOf: "2026-10-24T00:00:00Z",
    rows, holderCount: 60, newCount: 0, exitCount: 0, totalValue: null, valueScope: "loaded page", hasMore: true, nextOffset: 25,
    ...overrides,
  };
}

describe("13F holder index pages", () => {
  test("one row per filer holding shares: CUSIPs summed, options and exits left out", () => {
    const page = indexedHolderPage(holdings([
      row("1"),
      // A re-issued CUSIP under the same ticker is the same position.
      row("1", { id: "1:two", cusip: "000000002", shares: 5, previousShares: 5 }),
      row("2", { previousShares: null, action: "unknown" }),
      row("2", { id: "2:call", type: "CALL", shares: 100 }),
      row("3", { shares: null, previousShares: 40, action: "exit" }),
      row("4", { shares: 7, previousShares: 0, action: "new" }),
      row("5", { id: "5:a", shares: 3, previousShares: 1 }),
      row("5", { id: "5:b", cusip: "000000002", shares: 2, previousShares: null }),
    ]));
    expect(page.rows).toEqual([
      { cik: "1", name: "Fund 1", shares: 15, previousShares: 13 },
      { cik: "2", name: "Fund 2", shares: 10, previousShares: undefined },
      { cik: "4", name: "Fund 4", shares: 7, previousShares: 0 },
      // One CUSIP's prior position unknown leaves the whole change unknown.
      { cik: "5", name: "Fund 5", shares: 5, previousShares: undefined },
    ]);
    expect(page).toMatchObject({ period: "2026-06-30", holderCount: 60, hasMore: true, nextOffset: 25 });
    // Past the holder count only exits are left.
    expect(indexedHolderPage(holdings([], { holderCount: 25, nextOffset: 25 })).hasMore).toBe(false);
  });

  test("pages 25 at a time until the limit is met or the holders run out", async () => {
    const offsets: unknown[] = [];
    const client: IndexedHolderClient = {
      getCloudSec13F: async (_path, params = {}) => {
        offsets.push(params.offset);
        const offset = Number(params.offset);
        return holdings(Array.from({ length: 25 }, (_, index) => row(String(offset + index + 1))), { holderCount: 60, nextOffset: offset + 25, hasMore: true });
      },
    };
    const some = await loadIndexedHolders("AAA", 30, undefined, client);
    expect(offsets).toEqual([0, 25]);
    expect(some.rows).toHaveLength(50);
    offsets.length = 0;
    const all = await loadIndexedHolders("AAA", 200, undefined, client);
    expect(offsets).toEqual([0, 25, 50]);
    expect(all.rows.map((holder) => holder.cik).slice(-1)).toEqual(["75"]);
    expect(all.hasMore).toBe(false);
  });

  test("a page that does not move on ends the list, and a later page that fails keeps the holders loaded", async () => {
    let asked = 0;
    const stuck: IndexedHolderClient = {
      getCloudSec13F: async () => {
        asked += 1;
        return holdings(Array.from({ length: 25 }, (_, index) => row(String(index + 1))), { holderCount: 600, nextOffset: 0 });
      },
    };
    const once = await loadIndexedHolders("AAA", 200, undefined, stuck);
    expect(asked).toBe(1);
    expect(once).toMatchObject({ hasMore: false });
    expect(once.rows).toHaveLength(25);

    const failing: IndexedHolderClient = {
      getCloudSec13F: async (_path, params = {}) => {
        const offset = Number(params.offset);
        if (offset >= 50) throw new Error("HTTP 502");
        return holdings(Array.from({ length: 25 }, (_, index) => row(String(offset + index + 1))), { holderCount: 600, nextOffset: offset + 25 });
      },
    };
    const partial = await loadIndexedHolders("AAA", 100, undefined, failing);
    expect(partial.rows).toHaveLength(50);
    expect(partial.partial).toBe(true);
    expect(indexedHoldersPartialNote(partial, 100)).toBe("13F holders past the largest 50 could not be read this time.");
    // A first page that fails leaves the source's list to the caller.
    await expect(loadIndexedHolders("AAA", 100, undefined, { getCloudSec13F: async () => { throw new Error("HTTP 502"); } })).rejects.toThrow("HTTP 502");
  });

  test("asks only for a US line", () => {
    expect(indexHolderTicker("brk-b")).toBe("BRK.B");
    expect(indexHolderTicker("PBR", "NYSE", { exchange: "NYSE", currency: "USD", valueBasis: "latest_price" })).toBe("PBR");
    expect(indexHolderTicker("SAN:EPA")).toBeNull();
    expect(indexHolderTicker("BHP", "LSE")).toBeNull();
    // A home line priced from the filings is not the US line's list.
    expect(indexHolderTicker("BHP", "", { exchange: "LSE", currency: "GBp", valueBasis: "period_end_price" })).toBeNull();
  });
});
