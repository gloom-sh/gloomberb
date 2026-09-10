import type { SecFilingItem } from "../../../types/data-provider";
import { formatCompact, formatCurrency } from "../../../utils/format";
import { parseForm4Xml, transactionTypeLabel, type InsiderTransaction } from "./insider-data";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface ParsedInsiderFiling {
  filing: SecFilingItem;
  transaction: InsiderTransaction | null;
  isLoading: boolean;
}

export function parseInsiderFiling(filing: SecFilingItem, content: string | null, isLoading = false): ParsedInsiderFiling[] {
  const transactions = content ? parseForm4Xml(content) : [];
  return transactions.length
    ? transactions.map((transaction) => ({ filing, transaction, isLoading: false }))
    : [{ filing, transaction: null, isLoading }];
}

export function insiderTransactionId({ filing, transaction }: ParsedInsiderFiling): string {
  return `${filing.accessionNumber}:${transaction?.transactionIndex ?? 0}`;
}

/** Summarize only loaded non-derivative buys/sales, grouped by security. */
export function buildInsiderSummary(parsed: ParsedInsiderFiling[], now = Date.now()): string | null {
  if (parsed.some(({ isLoading }) => isLoading)) return null;
  const incomplete = parsed.some(({ transaction }) => !transaction?.filingDate || transaction.shares == null || !transaction.transactionType || !transaction.securityTitle);
  const cutoff = now - NINETY_DAYS_MS;
  const totals = new Map<string, { security: string; side: string; shares: number; value: number; knownValue: boolean }>();
  for (const { transaction } of parsed) {
    if (!transaction || transaction.isDerivative || transaction.shares == null || !transaction.securityTitle) continue;
    const date = transaction.filingDate?.getTime();
    if (date == null || !Number.isFinite(date) || date < cutoff || date > now) continue;
    if (transaction.transactionType !== "P" && transaction.transactionType !== "S") continue;
    const security = transaction.securityTitle;
    const key = `${security}:${transaction.transactionType}`;
    const total = totals.get(key) ?? { security, side: transaction.transactionType, shares: 0, value: 0, knownValue: true };
    total.shares += transaction.shares;
    total.knownValue &&= transaction.totalValue != null;
    total.value += transaction.totalValue ?? 0;
    totals.set(key, total);
  }
  const prefix = "Loaded filings, last 90 days: ";
  const coverage = incomplete ? " | Some transactions unavailable or incomplete." : "";
  if (totals.size === 0) return `${prefix}no parsed non-derivative buys/sales.${coverage}`;
  return prefix + [...totals.values()].map((total) => `${total.security}: ${total.side === "P" ? "Bought" : "Sold"} ${formatCompact(total.shares)} shares (${total.knownValue ? formatCurrency(total.value) : "value unavailable"})`).join(" | ") + coverage;
}

export function buildInsiderRows(parsed: readonly ParsedInsiderFiling[]) {
  return parsed.map((entry) => {
    const { filing, transaction, isLoading } = entry;
    return {
      id: insiderTransactionId(entry),
      filingDate: filing.filingDate instanceof Date ? filing.filingDate.toISOString() : String(filing.filingDate),
      transactionDate: transaction?.filingDate?.toISOString() ?? null,
      insider: transaction?.reportedName ?? null,
      reportingOwners: transaction?.reportingOwners ?? [],
      title: transaction?.title ?? null,
      security: transaction?.securityTitle ?? null,
      isDerivative: transaction?.isDerivative ?? null,
      side: transaction ? transactionTypeLabel(transaction.transactionType) : null,
      transactionCode: transaction?.transactionType ?? null,
      acquiredDisposed: transaction?.acquiredDisposed ?? null,
      ownershipType: transaction?.ownershipType ?? null,
      ownershipNature: transaction?.ownershipNature ?? null,
      shares: transaction?.shares ?? null,
      pricePerShare: transaction?.pricePerShare ?? null,
      totalValue: transaction?.totalValue ?? null,
      sharesOwnedAfter: transaction?.sharesOwned ?? null,
      form: filing.form,
      accessionNumber: filing.accessionNumber,
      url: filing.filingUrl,
      status: isLoading ? "loading" : !transaction ? "unavailable" : transaction.filingDate && transaction.shares != null && transaction.transactionType && transaction.securityTitle ? "parsed" : "partial",
    };
  });
}
