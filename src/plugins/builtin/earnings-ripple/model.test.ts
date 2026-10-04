import { describe, expect, test } from "bun:test";
import type { EarningsCalendarReport } from "../../../api-client/earnings";
import type { SupplyChainPayload, SupplyEntity, SupplyRow } from "../../../api-client/supply-chain";
import { projectRipple, rippleCustomerTickers } from "./model";

const entity = (ticker: string | null, exchange: string | null, aggregate = false): SupplyEntity =>
  ({ id: ticker ?? "anon", name: ticker ?? "Customer A", ticker, exchange, country: null, kind: "listed", identifiers: {}, anonymous: !ticker, aggregate });
const customer = (ticker: string | null, exchange: string | null, pct: number, extra: Partial<SupplyRow> = {}): SupplyRow => ({
  id: `${ticker}:${pct}:${extra.period ?? "2026-03-31"}:${extra.pctBasis ?? "revenue"}`, counterparty: entity(ticker, exchange), reportingEntity: entity("CRUS", "NASDAQ"),
  role: "customer", direction: "out", pctOfRevenue: pct, pctScope: null, pctBasis: "revenue", usd: null, usdBasis: null, period: "2026-03-31",
  fiscalYear: "2026", sourceKind: "xbrl", form: "10-K", filedDate: "2026-05-21", asOf: "2026-05-21", confidence: 1, quote: "q",
  quoteLanguage: null, quoteMatchMode: null, filingUrl: "https://www.sec.gov/x", accession: null, ...extra,
});
const chain = (symbol: string, says: SupplyRow[]): SupplyChainPayload => ({ symbol, entity: null, asOf: null, status: "available", says, names: [],
  counts: { says: { customer: says.length, supplier: 0, partner: 0, competitor: 0, investee: 0 }, names: { customer: 0, supplier: 0, partner: 0, competitor: 0, investee: 0 } },
  access: "preview", lockedRows: 0, totalRows: says.length, truncated: false, previewRowsPerRole: 3, disclaimer: "d" });
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
    expect(rippleCustomerTickers(chains).sort()).toEqual(["AAPL", "ARM"]);
  });

  test("shows a customer's average move only once ERN would, with enough reports behind it", () => {
    const rows = projectRipple(new Map([["CRUS", chain("CRUS", [customer("AAPL", "NASDAQ", 91), customer("ARM", "NASDAQ", 12)])]]),
      [report("AAPL", "2026-10-29"), { ...report("ARM", "2026-10-30"), averageReports: 2 }]);
    expect(rows.map((row) => [row.customer, row.averageMove])).toEqual([["AAPL", 0.025], ["ARM", null]]);
  });

  test("keeps listed US revenue customers that report, one per customer, with the holding's own report date", () => {
    const rows = projectRipple(new Map([
      ["CRUS", chain("CRUS", [
        customer("AAPL", "NASDAQ", 83, { period: "2025-03-31" }), customer("AAPL", "NASDAQ", 91),
        customer("2317", "TWSE", 39, { pctBasis: "revenue" }), customer("MSFT", "NASDAQ", 40, { pctBasis: "receivables" }),
        customer(null, null, 96), { ...customer("WMT", "NYSE", 12), counterparty: entity("WMT", "NYSE", true) },
      ])],
      ["QRVO", chain("QRVO", [customer("AAPL", "XNAS", 50)])],
    ]), [report("AAPL", "2026-10-29"), report("AAPL", "2027-01-28"), report("CRUS", "2026-11-03"), report("2317", "2026-10-20"),
      report("MSFT", "2026-11-04"), report("WMT", "2026-11-19")]);
    expect(rows.map((row) => [row.holding, row.customer, row.pctOfRevenue, row.date, row.holdingDate]))
      .toEqual([["CRUS", "AAPL", 91, "2026-10-29", "2026-11-03"], ["QRVO", "AAPL", 50, "2026-10-29", null]]);
  });
});
