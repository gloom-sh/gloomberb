import { expect, test } from "bun:test";
import type { MnaDealsParams, MnaDealsPayload } from "../../../api-client/mna";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext, HeadlessPaneOptionValues } from "../../../types/headless";
import { mnaHeadless } from "./headless";

const payload: MnaDealsPayload = {
  deals: [{
    id: "ath",
    target: { name: "Athabasca Oil Corporation", symbol: "ATH.TO", country: "CA" },
    acquirer: { name: "Cenovus Energy Inc.", symbol: "CVE.TO", country: "CA" },
    status: "pending",
    stage: null,
    hostile: false,
    terms: { consideration: "mixed", cashPerShare: 12, exchangeRatio: 0.264, ratioSymbol: "CVE.TO", currency: "CAD", cvr: false, partial: false, election: true },
    value: 4.1e9,
    valueCurrency: "CAD",
    valueUsd: 3e9,
    announced: "2026-09-10",
    expectedClose: "2026-12-31",
    closed: null,
    headline: "Cenovus to buy Athabasca Oil",
    updatedAt: "2026-09-17T00:00:00Z",
    lastReported: "2026-09-17",
    stale: false,
  }],
  hasMore: false,
  nextOffset: 1,
  access: "full",
  delayDays: 0,
  lockedDeals: 0,
  asOf: "2026-09-27T12:00:00Z",
};

async function load(symbol: string | null, options: HeadlessPaneOptionValues = {}) {
  const requests: MnaDealsParams[] = [];
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudMnaDeals: async (params: MnaDealsParams) => { requests.push(params); return payload; } } as unknown as HeadlessPaneContext["apiClient"],
  });
  const result = await mnaHeadless.load(createTestHeadlessArgs({ rawArgument: symbol ?? "", argument: symbol, symbols: symbol ? [symbol] : [], options }), ctx);
  return { result, request: requests[0]! };
}

test("a listing abroad asks for deals by the symbol they are filed under, with no name search beside it", async () => {
  // `fn MA ATH.TO` reaches the function as the listing its quote names.
  const { result, request } = await load("ATH:TSX");
  expect(request).toMatchObject({ symbol: "ATH.TO", status: "all" });
  expect(request.query).toBeUndefined();
  expect(result.rows.map((row) => row.targetSymbol)).toEqual(["ATH.TO"]);
  expect(result.metadata?.notices).toBeUndefined();
  expect((await load("CVE:TSX")).request.symbol).toBe("CVE.TO");
});

test("a US ticker, with or without its venue, and the market's deals ask as before", async () => {
  expect((await load("ACVA")).request).toMatchObject({ symbol: "ACVA", status: "all" });
  expect((await load("ACVA:NASDAQ")).request.symbol).toBe("ACVA");
  const market = (await load(null, { target: "public" })).request;
  expect(market).toMatchObject({ status: "pending", target: "public" });
  expect(market.symbol).toBeUndefined();
});

test("a company with no deal says so as the pane does, not that MA does not cover it", async () => {
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudMnaDeals: async () => ({ ...payload, deals: [] }) } as unknown as HeadlessPaneContext["apiClient"],
  });
  const result = await mnaHeadless.load(createTestHeadlessArgs({ rawArgument: "KO", argument: "KO", symbols: ["KO"], options: { status: "pending" } }), ctx);
  expect(result).toMatchObject({ empty: "No pending deals involving KO.", unavailableSymbols: [] });
});

// The spread columns were inserted before Stage, Close and Closed, moving them for a script reading the CSV by position.
test("the CSV keeps an earlier export's columns where they were, the spread's and the outside date's after them", async () => {
  const { headlessReportTables } = await import("../../../cli/pane-functions/headless");
  const { deriveHeadlessFreshness } = await import("../../../cli/pane-functions/freshness");
  const { renderReportCsv } = await import("../../../cli/report-tables");
  const { result } = await load("ATH.TO");
  const args = createTestHeadlessArgs({ rawArgument: "ATH.TO", argument: "ATH.TO", symbols: ["ATH.TO"] });
  const freshness = deriveHeadlessFreshness(mnaHeadless, result);
  const header = renderReportCsv(headlessReportTables(mnaHeadless, result, args, "M&A", freshness, { complete: true, unavailableSymbols: [] }), freshness).split("\n")[0]!;
  const columns = header.split(",");
  expect(columns.slice(0, 9)).toEqual(["Announced", "Target", "Symbol", "Acquirer", "Terms", "Value", "Stage", "Close", "Closed"]);
  const added = ["Spread", "As of", "Latest", "Latest as of", "Outside"].map((name) => columns.findIndex((column) => column.startsWith(name)));
  expect(added.every((index) => index > columns.indexOf("Closed"))).toBe(true);
});

test("--terms keeps the deals with per-share terms or the ones without, reading pages until the limit is met", async () => {
  const noTerms = { ...payload.deals[0]!, terms: { ...payload.deals[0]!.terms, consideration: "cash" as const, cashPerShare: null, exchangeRatio: null, ratioSymbol: null } };
  const pages = [
    { ...payload, deals: [{ ...noTerms, id: "a" }, { ...noTerms, id: "b" }], hasMore: true, nextOffset: 2 },
    { ...payload, deals: [{ ...payload.deals[0]!, id: "priced" }, { ...noTerms, id: "c" }], hasMore: false, nextOffset: 4 },
  ];
  const requests: MnaDealsParams[] = [];
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudMnaDeals: async (params: MnaDealsParams) => { requests.push(params); return pages[params.offset ? 1 : 0]!; } } as unknown as HeadlessPaneContext["apiClient"],
  });
  const run = (terms: string, limit = 2) => mnaHeadless.load(createTestHeadlessArgs({ rawArgument: "", argument: null, symbols: [], options: { terms, limit } }), ctx);
  const priced = await run("priced");
  expect(priced.rows.map((row) => row.id)).toEqual(["priced"]);
  expect(requests.map((params) => params.offset ?? 0)).toEqual([0, 2]);
  requests.length = 0;
  // Two deals without terms are on the first page: no second read, and no spread columns.
  const unpriced = await run("unpriced");
  expect(unpriced.rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(requests).toHaveLength(1);
  expect(unpriced.columns!.map((column) => column.key)).not.toContain("spread");
  expect(unpriced.metadata?.hasMore).toBe(true);
});
