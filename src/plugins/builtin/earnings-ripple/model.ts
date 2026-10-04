import type { EarningsCalendarReport, EarningsTiming } from "../../../api-client/earnings";
import type { SupplyChainPayload, SupplyRow } from "../../../api-client/supply-chain";
import { isUsListingExchange } from "../../../utils/exchanges";
import { MIN_AVERAGE_REPORTS } from "../earnings/board-model";

/** Days ahead the calendar is read. */
export const RIPPLE_DAYS = 30;

export interface RippleRow {
  id: string;
  /** The customer that reports. */
  customer: string;
  customerName: string;
  date: string;
  timing: EarningsTiming | null;
  /** Mean absolute move over the customer's last reports, once it has as many as ERN requires. */
  averageMove: number | null;
  /** The holding whose filing names the customer. */
  holding: string;
  /** Share of the holding's revenue, in percent, as its filing discloses it. */
  pctOfRevenue: number;
  pctScope: string | null;
  period: string;
  /** The holding's own next report in the window, when it has one. */
  holdingDate: string | null;
}

/**
 * The listed customers a holding names in its own filings with a share of its
 * revenue: one per customer, the latest period, then the larger share.
 * Receivables and purchase shares measure something else and are left out.
 */
function revenueCustomers(chain: SupplyChainPayload): SupplyRow[] {
  const best = new Map<string, SupplyRow>();
  for (const row of chain.says) {
    const ticker = row.counterparty.ticker;
    if (row.role !== "customer" || !ticker || row.counterparty.aggregate || row.pctBasis !== "revenue" || row.pctOfRevenue == null) continue;
    // The calendar covers US listings; a foreign code such as Foxconn's 2317 could collide with one.
    if (row.counterparty.exchange && !isUsListingExchange(row.counterparty.exchange)) continue;
    const key = ticker.toUpperCase();
    const current = best.get(key);
    if (!current || row.period > current.period || (row.period === current.period && row.pctOfRevenue > current.pctOfRevenue!)) best.set(key, row);
  }
  return [...best.values()];
}

/** Calendar symbols use the same customer eligibility as the displayed rows. */
export function rippleCustomerTickers(chains: ReadonlyMap<string, SupplyChainPayload>): string[] {
  const customers = new Set<string>();
  for (const [holding, chain] of chains) {
    for (const row of revenueCustomers(chain)) {
      const customer = row.counterparty.ticker!.toUpperCase();
      if (customer !== holding.toUpperCase()) customers.add(customer);
    }
  }
  return [...customers];
}

/** Customers of the holdings that report in the calendar, soonest first, then by the holding's exposure. */
export function projectRipple(chains: ReadonlyMap<string, SupplyChainPayload>, reports: readonly EarningsCalendarReport[]): RippleRow[] {
  const next = new Map<string, EarningsCalendarReport>();
  for (const report of reports) {
    const key = report.symbol.toUpperCase();
    const current = next.get(key);
    if (!current || report.date < current.date) next.set(key, report);
  }
  const rows: RippleRow[] = [];
  for (const [holding, chain] of chains) {
    for (const row of revenueCustomers(chain)) {
      const customer = row.counterparty.ticker!.toUpperCase();
      const report = next.get(customer);
      if (!report || customer === holding.toUpperCase()) continue;
      rows.push({ id: `${holding}:${customer}`, customer, customerName: report.name ?? row.counterparty.name, date: report.date,
        timing: report.timing, averageMove: report.averageReports >= MIN_AVERAGE_REPORTS ? report.averageMove : null, holding, pctOfRevenue: row.pctOfRevenue!, pctScope: row.pctScope,
        period: row.period, holdingDate: next.get(holding.toUpperCase())?.date ?? null });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || b.pctOfRevenue - a.pctOfRevenue || a.holding.localeCompare(b.holding));
}
