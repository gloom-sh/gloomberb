import { describe, expect, test } from "bun:test";
import type { EarningsCalendarReport } from "../../../api-client/earnings";
import type { SupplyChainPayload, SupplyEntity, SupplyRow } from "../../../api-client/supply-chain";
import type { GraphPath, GraphPayload } from "../../../api-client/supply-chain-graph";
import { hopLabel, projectRipple, projectSecondHop, rippleCompanyTickers } from "./model";

const entity = (ticker: string | null, exchange: string | null, aggregate = false): SupplyEntity =>
  ({ id: ticker ?? "anon", name: ticker ?? "Customer A", ticker, exchange, country: null, kind: "listed", identifiers: {}, anonymous: !ticker, aggregate });
const customer = (ticker: string | null, exchange: string | null, pct: number, extra: Partial<SupplyRow> = {}): SupplyRow => ({
  id: `${ticker}:${pct}:${extra.period ?? "2026-03-31"}:${extra.pctBasis ?? "revenue"}`, counterparty: entity(ticker, exchange), reportingEntity: entity("CRUS", "NASDAQ"),
  role: "customer", direction: "out", pctOfRevenue: pct, pctScope: null, pctBasis: "revenue", usd: null, usdBasis: null, period: "2026-03-31",
  fiscalYear: "2026", sourceKind: "xbrl", form: "10-K", filedDate: "2026-05-21", asOf: "2026-05-21", confidence: 1, quote: "q",
  quoteLanguage: null, quoteMatchMode: null, filingUrl: "https://www.sec.gov/x", accession: null, ...extra,
});
const chain = (symbol: string, says: SupplyRow[], names: SupplyRow[] = []): SupplyChainPayload => ({ symbol, entity: null, asOf: null, status: "available", says, names,
  counts: { says: { customer: says.length, supplier: 0, partner: 0, competitor: 0, investee: 0 }, names: { customer: 0, supplier: names.length, partner: 0, competitor: 0, investee: 0 } },
  access: "preview", lockedRows: 0, totalRows: says.length + names.length, truncated: false, previewRowsPerRole: 3, disclaimer: "d" });
const report = (symbol: string, date: string): EarningsCalendarReport => ({ symbol, name: symbol, date, timing: "amc", averageMove: 0.025, averageReports: 8 } as EarningsCalendarReport);

describe("earnings ripple", () => {
  test("collects uppercase customer tickers across holdings using the displayed revenue-customer filters", () => {
    const chains = new Map([
      ["CRUS", chain("CRUS", [
        customer("aapl", "NASDAQ", 91), customer("AAPL", "NASDAQ", 83, { period: "2025-03-31" }),
        customer("2317", "TWSE", 39), customer("MSFT", "NASDAQ", 40, { pctBasis: "receivables" }),
        customer(null, null, 96), { ...customer("WMT", "NYSE", 12), counterparty: entity("WMT", "NYSE", true) },
        customer("NVDA", "NASDAQ", 10, { role: "supplier" }), customer("AVGO", "NASDAQ", 10, { pctOfRevenue: null }),
        customer("crus", "NASDAQ", 10),
      ])],
      ["qrvo", chain("QRVO", [customer("AAPL", "XNAS", 50), customer("arm", "NASDAQ", 12), customer("QRVO", "NASDAQ", 10)])],
    ]);
    expect(rippleCompanyTickers(chains).sort()).toEqual(["AAPL", "ARM"]);
  });

  test("shows a customer's average move only once ERN would, with enough reports behind it", () => {
    const rows = projectRipple(new Map([["CRUS", chain("CRUS", [customer("AAPL", "NASDAQ", 91), customer("ARM", "NASDAQ", 12)])]]),
      [report("AAPL", "2026-10-29"), { ...report("ARM", "2026-10-30"), averageReports: 2 }]);
    expect(rows.map((row) => [row.company, row.averageMove])).toEqual([["AAPL", 0.025], ["ARM", null]]);
  });

  test("keeps listed US revenue customers and suppliers that report, one per company, with the holding's own report date", () => {
    const rows = projectRipple(new Map([
      ["CRUS", chain("CRUS", [
        customer("AAPL", "NASDAQ", 83, { period: "2025-03-31" }), customer("AAPL", "NASDAQ", 91),
        customer("2317", "TWSE", 39, { pctBasis: "revenue" }), customer("MSFT", "NASDAQ", 40, { pctBasis: "receivables" }),
        customer(null, null, 96), { ...customer("WMT", "NYSE", 12), counterparty: entity("WMT", "NYSE", true) },
      ])],
      ["QRVO", chain("QRVO", [customer("AAPL", "XNAS", 50)])],
      // Suppliers come from their own filings naming the holding; the share is of the supplier's revenue.
      ["AAPL", chain("AAPL", [], [customer("CRUS", "NASDAQ", 91, { role: "supplier", direction: "in" }),
        customer("PLTK", "NASDAQ", 56, { role: "supplier", direction: "in", pctBasis: "receivables" })])],
    ]), [report("AAPL", "2026-10-29"), report("AAPL", "2027-01-28"), report("CRUS", "2026-11-03"), report("2317", "2026-10-20"),
      report("MSFT", "2026-11-04"), report("WMT", "2026-11-19"), report("PLTK", "2026-11-05")]);
    expect(rows.map((row) => [row.holding, row.link, row.company, row.pctOfRevenue, row.date, row.holdingDate])).toEqual([
      ["CRUS", "customer", "AAPL", 91, "2026-10-29", "2026-11-03"], ["QRVO", "customer", "AAPL", 50, "2026-10-29", null],
      ["AAPL", "supplier", "CRUS", 91, "2026-11-03", "2026-10-29"],
    ]);
  });

  test("two hops: keeps the route and each hop's share, and drops anyone already one hop away", () => {
    const nodes = [entity("NVDA", "NASDAQ"), entity("TSM", "NYSE"), entity("ASML", "NASDAQ"), entity("MSFT", "NASDAQ"), entity("SMCI", "NASDAQ"),
      entity("2317", "TWSE"), entity("AMAT", "NASDAQ")];
    const id = (ticker: string) => nodes.findIndex((node) => node.ticker === ticker);
    // Each link's primary evidence: the reporting company's own share of revenue, or none.
    const link = (from: string, to: string, reporter: string, pct: number | null) => ({ id: `${from}>${to}`, from: from, to, relationship: "commerce" as const,
      primaryEvidenceId: `${from}>${to}:e`, confidence: 0.9, weight: 0.5,
      evidence: [{ id: `${from}>${to}:e`, reporter: nodes[id(reporter)]!, pctOfRevenue: pct, pctBasis: pct == null ? null : "revenue", pctScope: null }] });
    const links = [link("TSM", "NVDA", "TSM", 22), link("ASML", "TSM", "ASML", 29), link("SMCI", "TSM", "SMCI", 5), link("NVDA", "MSFT", "NVDA", 19),
      link("MSFT", "2317", "MSFT", 8), link("MSFT", "ASML", "MSFT", 3), link("MSFT", "AMAT", "MSFT", null)];
    const path = (tickers: string[], score: number, exposure: GraphPath["exposure"] = null): GraphPath => ({ id: tickers.join("|"), nodeIds: tickers, hops: tickers.length - 1, score, confidence: 0.8, exposure,
      linkIds: tickers.slice(1).map((ticker, index) => links.find((entry) => [entry.from, entry.to].sort().join() === [tickers[index]!, ticker].sort().join())!.id) });
    const reach = (direction: "upstream" | "downstream", tickers: string[], score = 0.5, exposure: GraphPath["exposure"] = null) =>
      ({ entityId: tickers.at(-1)!, direction, hops: tickers.length - 1, bestPath: path(tickers, score, exposure), shortestPath: path(tickers, score, exposure) });
    const graph = { symbol: "NVDA", entity: nodes[0]!, nodes: nodes.map((node) => ({ ...node, id: node.ticker! })), links, access: "full",
      upstream: [reach("upstream", ["NVDA", "TSM"]), reach("upstream", ["NVDA", "TSM", "ASML"], 0.4, { pct: 6.38, basis: "revenue", period: "2026", denominatorEntityId: "TSM", estimated: true }),
        reach("upstream", ["NVDA", "TSM", "SMCI"])],
      downstream: [reach("downstream", ["NVDA", "MSFT"]), reach("downstream", ["NVDA", "MSFT", "2317"]), reach("downstream", ["NVDA", "MSFT", "ASML"], 0.1),
        reach("downstream", ["NVDA", "MSFT", "AMAT"])],
      related: [], paths: [] } as unknown as GraphPayload;
    // SMCI is already a direct customer in NVDA's own disclosures.
    const chains = new Map([["NVDA", chain("NVDA", [customer("SMCI", "NASDAQ", 9)])]]);
    const rows = projectSecondHop(chains, new Map([["NVDA", graph]]),
      ["TSM", "ASML", "SMCI", "MSFT", "2317", "AMAT"].map((symbol) => report(symbol, "2026-10-20")).concat(report("NVDA", "2026-11-19")));
    expect(rows.map((row) => [row.company, row.link, row.via, row.hops.map(hopLabel).join(" › "), row.exposure, row.holdingDate])).toEqual([
      ["AMAT", "customer", "MSFT", "19% of NVDA › --", null, "2026-11-19"],
      ["ASML", "supplier", "TSM", "22% of TSM › 29% of ASML", "6.38% est. of TSM revenue", "2026-11-19"],
    ]);
  });
});
