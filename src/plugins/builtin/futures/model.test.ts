import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { cycleSortPreference } from "../../../utils/sort-values";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { getContractsBySector, type FuturesSector } from "./contracts";
import {
  buildFuturesRows,
  DEFAULT_FUTURES_SORT,
  effectiveCollapsedSectors,
  futuresContractName,
  nextFuturesSort,
  type FuturesColumnId,
  type FuturesTableRow,
} from "./model";

const contractsBySector = getContractsBySector();
const EMPTY_QUOTES: BoardQuoteMap = new Map();

function rowIds(rows: FuturesTableRow[]): string[] {
  return rows.map((row) => row.type === "header" ? `header:${row.sector}` : row.contract.symbol);
}

function quoteMap(entries: Record<string, Partial<Quote>>): BoardQuoteMap {
  return new Map(
    Object.entries(entries).map(([symbol, quote]) => [
      symbol,
      { quote: quote as Quote, loading: false, error: null, stale: false },
    ]),
  );
}

describe("buildFuturesRows search", () => {
  test("labels each alias with its catalog name and the quoted contract's month", () => {
    const quotes = quoteMap({
      "CL=F": { symbol: "CL=F", name: "Crude Oil Oct 26" },
      "BZ=F": { symbol: "BZ=F", name: "Brent Crude Oil Last Day Financ" },
    });
    const contract = (symbol: string) => [...contractsBySector.values()].flat().find((row) => row.symbol === symbol)!;
    const name = (symbol: string, quoteName: string) => futuresContractName(contract(symbol), { symbol, name: quoteName } as Quote);
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, quotes, { query: "oct 26" })))
      .toEqual(["header:energy", "CL=F"]);
    quotes.get("CL=F")!.quote!.name = "Crude Oil Nov 26";
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, quotes, { query: "oct 26" }))).toEqual([]);
    expect(futuresContractName(contract("CL=F"), quotes.get("CL=F")!.quote)).toBe("WTI Crude Oil Nov 26");
    expect(futuresContractName(contract("BZ=F"), quotes.get("BZ=F")!.quote)).toBe("Brent Crude Oil");
    expect(name("ZC=F", "Corn Futures,Dec-2026")).toBe("Corn Dec 26");
    expect(name("ZB=F", "30-Year T-Bond Dec 26")).toBe("30-Year T-Bond Dec 26");
    // Cut off inside the year: the month alone could be a year out.
    expect(name("ZW=F", "Chicago SRW Wheat Futures,Dec-2")).toBe("Chicago SRW Wheat");
    expect(name("6C=F", "Canadian Dollar Futures,Dec-202")).toBe("Canadian Dollar");
    expect(futuresContractName(contract("CL=F"), { symbol: "OTHER", name: "Crude Oil Nov 26" } as Quote)).toBe("WTI Crude Oil");
  });

  test("matches contract code, name, and Yahoo symbol case-insensitively", () => {
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "gc" })))
      .toEqual(["header:metals", "GC=F"]);
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "crude" })))
      .toEqual(["header:energy", "CL=F", "BZ=F"]);
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "6J=f" })))
      .toEqual(["header:currencies", "6J=F"]);
  });

  test("drops a sector header when every contract in it is filtered out", () => {
    const rows = buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "copper" });
    expect(rowIds(rows)).toEqual(["header:metals", "HG=F"]);
  });

  test("a query matching nothing yields no rows at all, not bare headers", () => {
    expect(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "zzz" })).toEqual([]);
  });
});

describe("buildFuturesRows collapse", () => {
  test("keeps a collapsed sector's header while hiding its contracts", () => {
    const rows = buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, {
      collapsed: new Set(["energy"]),
    });
    expect(rows.some((row) => row.type === "header" && row.sector === "energy")).toBe(true);
    expect(rows.some((row) => row.type === "row" && row.contract.sector === "energy")).toBe(false);
    expect(rows.some((row) => row.type === "row" && row.contract.sector === "metals")).toBe(true);
  });

  test("a live search overrides collapsed sectors instead of hiding its own matches", () => {
    const rows = buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, {
      query: "gold",
      collapsed: new Set(["metals"]),
    });
    expect(rowIds(rows)).toEqual(["header:metals", "GC=F"]);
  });

  test("clearing the search restores the collapsed state, whitespace included", () => {
    const collapsed = new Set<FuturesSector>(["metals"]);
    expect(effectiveCollapsedSectors(collapsed, "gold").has("metals")).toBe(false);
    expect(effectiveCollapsedSectors(collapsed, "   ").has("metals")).toBe(true);
    expect(effectiveCollapsedSectors(collapsed, "").has("metals")).toBe(true);
    expect(effectiveCollapsedSectors(collapsed, undefined).has("metals")).toBe(true);
  });
});

describe("futures sorting", () => {
  test("sorts within a sector, never across sectors", () => {
    const quotes = quoteMap({
      "ES=F": { price: 7731 },
      "NQ=F": { price: 29670 },
      "YM=F": { price: 53499 },
      "RTY=F": { price: 3046 },
      "GC=F": { price: 4451 },
    });
    const rows = buildFuturesRows(
      contractsBySector,
      { columnId: "price", direction: "desc" },
      quotes,
      { query: "e-mini" },
    );
    expect(rowIds(rows)).toEqual(["header:equity-index", "YM=F", "NQ=F", "ES=F", "RTY=F"]);
  });

  test("header clicks walk ascending, descending, then back to catalog order", () => {
    const ascending = nextFuturesSort(DEFAULT_FUTURES_SORT, "code");
    const descending = nextFuturesSort(ascending, "code");
    expect(ascending).toEqual({ columnId: "code", direction: "asc" });
    expect(descending).toEqual({ columnId: "code", direction: "desc" });
    expect(nextFuturesSort(descending, "code")).toEqual(DEFAULT_FUTURES_SORT);
    expect(nextFuturesSort(descending, "price")).toEqual({ columnId: "price", direction: "asc" });
  });

  test("the keyboard cycle reaches every state a header click can, and wraps", () => {
    const columnIds: FuturesColumnId[] = ["code", "price"];
    const seen = [DEFAULT_FUTURES_SORT];
    let current = DEFAULT_FUTURES_SORT;
    for (let step = 0; step < 4; step += 1) {
      current = cycleSortPreference(columnIds, current, 1, { allowUnsorted: true });
      seen.push(current);
    }
    expect(seen).toEqual([
      { columnId: null, direction: "asc" },
      { columnId: "code", direction: "asc" },
      { columnId: "code", direction: "desc" },
      { columnId: "price", direction: "asc" },
      { columnId: "price", direction: "desc" },
    ]);
    expect(cycleSortPreference(columnIds, current, 1, { allowUnsorted: true })).toEqual(DEFAULT_FUTURES_SORT);
    expect(cycleSortPreference(columnIds, DEFAULT_FUTURES_SORT, -1, { allowUnsorted: true }))
      .toEqual({ columnId: "price", direction: "desc" });
  });

  test("cycling skips columns the user hid", () => {
    expect(cycleSortPreference<FuturesColumnId>(["name"], { columnId: "name", direction: "desc" }, 1))
      .toEqual({ columnId: "name", direction: "asc" });
  });
});
