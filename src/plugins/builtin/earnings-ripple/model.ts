import type { EarningsCalendarReport, EarningsTiming } from "../../../api-client/earnings";
import type { SupplyChainPayload, SupplyRow } from "../../../api-client/supply-chain";
import { isUsListingExchange } from "../../../utils/exchanges";
import { MIN_AVERAGE_REPORTS } from "../earnings/board-model";

/** Days ahead the calendar is read. */
export const RIPPLE_DAYS = 30;

export interface RippleRow {
  id: string;
  /** The company that reports. */
  company: string;
  companyName: string;
  /** `customer`: the company buys from the holding. `supplier`: it sells to the holding. */
  link: "customer" | "supplier";
  date: string;
  timing: EarningsTiming | null;
  /** Mean absolute move over the company's last reports, once it has as many as ERN requires. */
  averageMove: number | null;
  holding: string;
  /**
   * Percent of the seller's revenue, as the seller's filing discloses it: the
   * holding's revenue for a customer, the supplier's revenue for a supplier.
   */
  pctOfRevenue: number;
  pctScope: string | null;
  period: string;
  /** The holding's own next report in the window, when it has one. */
  holdingDate: string | null;
}

/** Whose revenue the share is of. */
export const revenueOwner = (row: RippleRow) => row.link === "customer" ? row.holding : row.company;

/**
 * Listed counterparties in one role with a share of the seller's revenue: one
 * per company, the latest period, then the larger share. Receivables and
 * purchase shares measure something else and are left out.
 */
function revenueLinks(rows: readonly SupplyRow[], role: "customer" | "supplier"): SupplyRow[] {
  const best = new Map<string, SupplyRow>();
  for (const row of rows) {
    const ticker = row.counterparty.ticker;
    if (row.role !== role || !ticker || row.counterparty.aggregate || row.pctBasis !== "revenue" || row.pctOfRevenue == null) continue;
    // The calendar covers US listings; a foreign code such as Foxconn's 2317 could collide with one.
    if (row.counterparty.exchange && !isUsListingExchange(row.counterparty.exchange)) continue;
    const key = ticker.toUpperCase();
    const current = best.get(key);
    if (!current || row.period > current.period || (row.period === current.period && row.pctOfRevenue > current.pctOfRevenue!)) best.set(key, row);
  }
  return [...best.values()];
}

/** Customers a holding names (`says`) and suppliers that name it (`names`), each with its link. */
function rippleLinks(chain: SupplyChainPayload) {
  return [
    ...revenueLinks(chain.says, "customer").map((row) => ({ row, link: "customer" as const })),
    ...revenueLinks(chain.names, "supplier").map((row) => ({ row, link: "supplier" as const })),
  ];
}

/** Calendar symbols use the same eligibility as the displayed rows, in both directions. */
export function rippleCompanyTickers(chains: ReadonlyMap<string, SupplyChainPayload>): string[] {
  const companies = new Set<string>();
  for (const [holding, chain] of chains) {
    for (const { row } of rippleLinks(chain)) {
      const company = row.counterparty.ticker!.toUpperCase();
      if (company !== holding.toUpperCase()) companies.add(company);
    }
  }
  return [...companies];
}

/**
 * Customers a holding names in its own filings (`says`), and suppliers whose
 * filings name the holding as a customer (`names`), that report in the
 * calendar: soonest first, then by the share.
 */
export function projectRipple(chains: ReadonlyMap<string, SupplyChainPayload>, reports: readonly EarningsCalendarReport[]): RippleRow[] {
  const next = new Map<string, EarningsCalendarReport>();
  for (const report of reports) {
    const key = report.symbol.toUpperCase();
    const current = next.get(key);
    if (!current || report.date < current.date) next.set(key, report);
  }
  const rows: RippleRow[] = [];
  for (const [holding, chain] of chains) {
    for (const { row, link } of rippleLinks(chain)) {
      const company = row.counterparty.ticker!.toUpperCase();
      const report = next.get(company);
      if (!report || company === holding.toUpperCase()) continue;
      rows.push({ id: `${holding}:${link}:${company}`, company, companyName: report.name ?? row.counterparty.name, link, date: report.date,
        timing: report.timing, averageMove: report.averageReports >= MIN_AVERAGE_REPORTS ? report.averageMove : null, holding, pctOfRevenue: row.pctOfRevenue!, pctScope: row.pctScope,
        period: row.period, holdingDate: next.get(holding.toUpperCase())?.date ?? null });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || b.pctOfRevenue - a.pctOfRevenue || a.holding.localeCompare(b.holding));
}
