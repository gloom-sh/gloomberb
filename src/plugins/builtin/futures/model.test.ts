import { describe, expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { cycleSortPreference } from "../../../utils/sort-values";
import type { BoardQuoteMap } from "../shared/use-quote-board";
import { getContractsBySector, type FuturesSector } from "../../../market-data/futures-board";
import {
  buildFuturesRows,
  DEFAULT_FUTURES_SORT,
  effectiveCollapsedSectors,
  futuresContractHeadline,
  futuresContractName,
  futuresUnitLabel,
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
    // Cut two digits into the year, it would read as 2020.
    expect(name("QM=F", "E-mini Crude Oil Futures,Nov-20")).toBe("E-Mini Crude Oil");
    expect(futuresContractName(contract("CL=F"), { symbol: "OTHER", name: "Crude Oil Nov 26" } as Quote)).toBe("WTI Crude Oil");
  });

  test("names the nearer month and its expiry once the alias has rolled past it, and the day's most active month apart", () => {
    const crude = [...contractsBySector.values()].flat().find((row) => row.symbol === "CL=F")!;
    // 2026-10-19, CLX26's roll date: CL=F is on December while November trades until the 20th.
    const december = { symbol: "CL=F", name: "WTI Crude Oil Dec 26" } as Quote;
    const nearest = { contract: "CLX26", contractSymbol: "CLX26.NYM", deliveryMonth: "2026-11", lastTrade: "2026-10-20" };
    const terms = { deliveryMonth: "2026-12", nearest };
    expect(futuresContractHeadline(crude, december, terms)).toBe("WTI Crude Oil Dec 26, rolled (Nov expires 20 Oct)");
    // The month leads, so a column clipping the tail keeps it; one too narrow for "rolled" shows the plain name.
    expect(futuresContractHeadline(crude, december, terms, 28)).toBe("WTI Crude Oil Dec 26, rolled (Nov expires 20 Oct)");
    expect(futuresContractHeadline(crude, december, terms, 27)).toBe("WTI Crude Oil Dec 26");
    // A quote whose name carries no month is placed by its terms.
    expect(futuresContractHeadline(crude, { symbol: "CL=F" } as Quote, terms)).toBe("WTI Crude Oil Dec 26, rolled (Nov expires 20 Oct)");
    // Once the alias quotes the nearest month itself, or before the terms load, it is the plain name.
    expect(futuresContractHeadline(crude, december, { deliveryMonth: "2026-12", nearest: null })).toBe("WTI Crude Oil Dec 26");
    expect(futuresContractHeadline(crude, december, null)).toBe("WTI Crude Oil Dec 26");
    // Terms read before a roll the quote already took never mix months.
    expect(futuresContractHeadline(crude, { ...december, name: "WTI Crude Oil Jan 27" }, terms)).toBe("WTI Crude Oil Jan 27");
    expect(futuresContractHeadline(crude, december, { deliveryMonth: "2026-12", nearest: { ...nearest, lastTrade: null } }))
      .toBe("WTI Crude Oil Dec 26, rolled (Nov still trading)");

    // 2026-10-16: CL=F on November, its front until the roll; the day's volume was December's.
    const november = { symbol: "CL=F", name: "WTI Crude Oil Nov 26" } as Quote;
    const mostActive = { contract: "CLZ26", contractSymbol: "CLZ26.NYM", deliveryMonth: "2026-12", volume: 304_249, date: "2026-10-16" };
    expect(futuresContractHeadline(crude, november, { deliveryMonth: "2026-11", nearest: null, mostActive }))
      .toBe("WTI Crude Oil Nov 26, Dec most active");
    // The most active month in another year says which; the month the alias prices adds nothing.
    expect(futuresContractHeadline(crude, november, { deliveryMonth: "2026-11", mostActive: { ...mostActive, deliveryMonth: "2027-01" } }))
      .toBe("WTI Crude Oil Nov 26, Jan 27 most active");
    expect(futuresContractHeadline(crude, november, { deliveryMonth: "2026-11", mostActive: { ...mostActive, deliveryMonth: "2026-11" } }))
      .toBe("WTI Crude Oil Nov 26");
    // Both notes: the roll's first; a column without room for the second drops it.
    const both = { ...terms, mostActive: { ...mostActive, deliveryMonth: "2027-03" } };
    expect(futuresContractHeadline(crude, december, both)).toBe("WTI Crude Oil Dec 26, rolled (Nov expires 20 Oct), Mar 27 most active");
    expect(futuresContractHeadline(crude, december, both, 60)).toBe("WTI Crude Oil Dec 26, rolled (Nov expires 20 Oct)");
  });

  test("a row's unit is the exchange's from its terms, else the catalog's", () => {
    const row = (symbol: string) => [...contractsBySector.values()].flat().find((contract) => contract.symbol === symbol)!;
    const spec = { unit: "USD / barrel", size: "1,000 barrels", pointValue: 1000, tick: 0.01, tickValue: 10, settlement: "physical" as const };
    expect(futuresUnitLabel(row("CL=F"), { spec })).toBe("USD / barrel");
    expect(futuresUnitLabel(row("TTF=F"), { spec: null })).toBe("EUR / MWh");
    expect(futuresUnitLabel(row("CL=F"), null)).toBeNull();
  });

  test("matches contract code, name, and listed symbol case-insensitively", () => {
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "gc" })))
      .toEqual(["header:metals", "GC=F"]);
    expect(rowIds(buildFuturesRows(contractsBySector, DEFAULT_FUTURES_SORT, EMPTY_QUOTES, { query: "crude" })))
      .toEqual(["header:energy", "CL=F", "BZ=F", "QM=F", "MCL=F"]);
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
    // The micro Russell is priced below the micro crude, and still sorts inside its own sector.
    const quotes = quoteMap({
      "MES=F": { price: 7731 },
      "MNQ=F": { price: 29670 },
      "MYM=F": { price: 53499 },
      "M2K=F": { price: 30 },
      "MCL=F": { price: 95 },
      "MNG=F": { price: 3.2 },
      "GC=F": { price: 4451 },
    });
    const rows = buildFuturesRows(
      contractsBySector,
      { columnId: "price", direction: "desc" },
      quotes,
      { query: "micro" },
    );
    expect(rowIds(rows)).toEqual(["header:equity-index", "MYM=F", "MNQ=F", "MES=F", "M2K=F", "header:energy", "MCL=F", "MNG=F"]);
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
