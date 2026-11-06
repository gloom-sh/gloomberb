import { expect, test } from "bun:test";
import type { SocialOutlierRow, SocialOutliersPayload } from "../../../api-client/social-mentions";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { outlierListingName, withListingNames } from "./outliers-names";

// Invented companies.
function listing(symbol: string, exchange: string, name: string, extra: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol, exchange, name, type: "Common Stock", ...extra };
}
function row(symbol: string, name: string | null): SocialOutlierRow {
  return {
    symbol, name, day: "2026-11-05", mentions: 100, closed: true, countedAt: "2026-11-06T00:20:00.000Z", baseline: 40, ratio: 2.5,
    stance: null, stancePosts: 0, marketCap: null, price: null,
  };
}
const payload = (rows: SocialOutlierRow[]): SocialOutliersPayload => ({
  window: "day", asOf: "2026-11-06T16:30:00.000Z", freshFrom: "2026-11-03", filters: { minPosts: 25, cap: null }, coverage: { tracked: 10, counted: 5 }, rows,
});

test("a bare symbol is named by its US listing, the company's home line first, and never by a row that only repeats the symbol", () => {
  // Search order is relevance: a line abroad that carries the symbol for a name comes first here.
  expect(outlierListingName([
    listing("NWBI", "TSX", "NWBI"),
    listing("NWBI", "BMV", "Northwind Biologics SAB"),
    listing("NWBI", "NASDAQ", "Northwind Biologics, Inc."),
  ], "NWBI")).toBe("Northwind Biologics, Inc.");
  // Two US lines: the one the service marks as home.
  expect(outlierListingName([
    listing("CTSO", "NYSE", "Contoso Energy Corp. Class B"),
    listing("CTSO", "NASDAQ", "Contoso Energy Corporation", { homeListing: true }),
  ], "CTSO")).toBe("Contoso Energy Corporation");
  // No US listing: the symbol's own row abroad, never another symbol's.
  expect(outlierListingName([listing("FBKM", "XETR", "Fabrikam Bancorp AG"), listing("FBKM.EUR", "EPA", "Fabrikam ETP")], "FBKM")).toBe("Fabrikam Bancorp AG");
  expect(outlierListingName([listing("FBKM.EUR", "EPA", "Fabrikam ETP")], "FBKM")).toBeNull();
  // A name that is only the symbol, a blank one and no rows at all name nothing.
  expect(outlierListingName([listing("TSTX", "NASDAQ", "tstx"), listing("TSTX", "NYSE", "  ")], "TSTX")).toBeNull();
  expect(outlierListingName([], "TSTX")).toBeNull();
});

test("every ticker is one batched search, each once, and a row search has no name for keeps its stored one", async () => {
  const asked: Array<{ queries: string[]; limit?: number }> = [];
  const named = await withListingNames(payload([row("NWBI", "NORTHWIND BIOLOGICS INC"), row("FBKM", null), row("NWBI", "NORTHWIND BIOLOGICS INC"), row("QUIET", "QUIET CORP")]), {
    searchBatch: async (queries, options) => {
      asked.push({ queries: [...queries], limit: options?.limit });
      return new Map([
        ["NWBI", [listing("NWBI", "NASDAQ", "Northwind Biologics, Inc.")]],
        ["FBKM", [listing("FBKM", "NASDAQ", "Fabrikam Semiconductor ETF", { type: "ETF" })]],
        ["QUIET", []],
      ]);
    },
  });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.queries).toEqual(["NWBI", "FBKM", "QUIET"]);
  expect(named.rows.map((entry) => entry.name)).toEqual(["Northwind Biologics, Inc.", "Fabrikam Semiconductor ETF", "Northwind Biologics, Inc.", "QUIET CORP"]);
  // Nothing but the names changed.
  expect({ ...named, rows: [] as SocialOutlierRow[] }).toEqual(payload([]));
  expect(named.rows[0]).toEqual({ ...row("NWBI", null), name: "Northwind Biologics, Inc." });
});

test("no source, no batch, a failed batch or an empty ranking give the payload back as it came", async () => {
  const ranking = payload([row("NWBI", "NORTHWIND BIOLOGICS INC")]);
  expect(await withListingNames(ranking, null)).toBe(ranking);
  expect(await withListingNames(ranking, {})).toBe(ranking);
  expect(await withListingNames(ranking, { searchBatch: async () => null })).toBe(ranking);
  expect(await withListingNames(ranking, { searchBatch: async () => { throw new Error("Search is down."); } })).toBe(ranking);
  let asked = false;
  const empty = payload([]);
  expect(await withListingNames(empty, { searchBatch: async () => { asked = true; return new Map(); } })).toBe(empty);
  expect(asked).toBe(false);
});
