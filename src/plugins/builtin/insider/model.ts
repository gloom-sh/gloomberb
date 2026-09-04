import type { SecFilingItem } from "../../../types/data-provider";
import { formatCompact, formatCurrency } from "../../../utils/format";
import {
  transactionTypeLabel,
  type InsiderTransaction,
} from "./insider-data";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface ParsedInsiderFiling {
  filing: SecFilingItem;
  transaction: InsiderTransaction | null;
  isLoading: boolean;
}

/** Null while filings are still parsing, so the pane never claims no activity early. */
export function buildInsiderSummary(
  parsed: ParsedInsiderFiling[],
  now = Date.now(),
): string | null {
  if (parsed.some(({ isLoading }) => isLoading)) return null;
  const cutoff = new Date(now - NINETY_DAYS_MS);
  let buyShares = 0;
  let sellShares = 0;
  let buyValue = 0;
  let sellValue = 0;

  for (const { transaction } of parsed) {
    if (!transaction) continue;
    const txDate = transaction.filingDate instanceof Date
      ? transaction.filingDate
      : new Date(transaction.filingDate);
    if (Number.isNaN(txDate.getTime()) || txDate < cutoff) continue;
    if (transaction.transactionType === "P") {
      buyShares += transaction.shares;
      buyValue += transaction.totalValue ?? 0;
    } else if (transaction.transactionType === "S") {
      sellShares += transaction.shares;
      sellValue += transaction.totalValue ?? 0;
    }
  }

  if (buyShares === 0 && sellShares === 0) return "No buy/sell activity in last 90 days.";

  const parts: string[] = [];
  if (buyShares > 0) parts.push(`Bought ${formatCompact(buyShares)} shares (${formatCurrency(buyValue)})`);
  if (sellShares > 0) parts.push(`Sold ${formatCompact(sellShares)} shares (${formatCurrency(sellValue)})`);
  return parts.join("  |  ");
}

export function buildInsiderRows(parsed: readonly ParsedInsiderFiling[]) {
  return parsed.map(({ filing, transaction, isLoading }) => ({
    filingDate: filing.filingDate instanceof Date
      ? filing.filingDate.toISOString()
      : String(filing.filingDate),
    transactionDate: transaction?.filingDate instanceof Date
      ? transaction.filingDate.toISOString()
      : transaction?.filingDate ? String(transaction.filingDate) : null,
    insider: transaction?.reportedName ?? null,
    title: transaction?.title ?? null,
    side: transaction ? transactionTypeLabel(transaction.transactionType) : null,
    transactionCode: transaction?.transactionType ?? null,
    shares: transaction?.shares ?? null,
    pricePerShare: transaction?.pricePerShare ?? null,
    totalValue: transaction?.totalValue ?? null,
    sharesOwnedAfter: transaction?.sharesOwned ?? null,
    form: filing.form,
    accessionNumber: filing.accessionNumber,
    url: filing.filingUrl,
    status: isLoading ? "loading" : transaction ? "parsed" : "unavailable",
  }));
}
