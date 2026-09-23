import type { SecFilingItem } from "../../../types/data-provider";
import { formatCompact, formatCurrency } from "../../../utils/format";
import { parseForm4Xml, parseForm4Disclosure, transactionTypeLabel, type InsiderTransaction, type InsiderFilingDisclosure } from "./insider-data";
import { affectingInsiderAmendments, buildInsiderAmendmentScopes, isAmendedInsiderFiling } from "./amendments";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface ParsedInsiderFiling {
  filing: SecFilingItem;
  transaction: InsiderTransaction | null;
  isLoading: boolean;
  disclosure?: InsiderFilingDisclosure | null;
}

export function parseInsiderFiling(filing: SecFilingItem, content: string | null, isLoading = false): ParsedInsiderFiling[] {
  const transactions = content ? parseForm4Xml(content) : [];
  const disclosure = content ? parseForm4Disclosure(content) : null;
  return transactions.length
    ? transactions.map((transaction) => ({ filing, transaction, isLoading: false, disclosure }))
    : [{ filing, transaction: null, isLoading, disclosure }];
}

/**
 * A filing read without transaction lines: an unreconciled 4/A, or a Form 4
 * that reports none (e.g. the owner is no longer subject to Section 16).
 */
export function isInsiderDisclosureOnly(entry: ParsedInsiderFiling): boolean {
  return !entry.transaction && !!entry.disclosure
    && (isAmendedInsiderFiling(entry) || !entry.disclosure.hasTransactionLines);
}

export function insiderTransactionId({ filing, transaction }: ParsedInsiderFiling): string {
  return `${filing.accessionNumber}:${transaction?.transactionIndex ?? 0}`;
}

export function insiderReportedName(entry: ParsedInsiderFiling): string | null {
  return entry.transaction?.reportedName
    ?? (entry.disclosure?.reportingOwners.map((owner) => owner.name).filter(Boolean).join("; ") || null);
}

export function matchesInsiderOwner(entry: ParsedInsiderFiling, name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return insiderReportedName(entry)?.toLocaleLowerCase() === normalized
    || (entry.disclosure?.reportingOwners ?? entry.transaction?.reportingOwners ?? [])
      .some((owner) => owner.name.toLocaleLowerCase() === normalized);
}

export function buildInsiderDisclosureText(entry: ParsedInsiderFiling): string {
  const disclosure = entry.disclosure;
  if (!disclosure) return "";
  return [
    disclosure.remarks ? `Remarks: ${disclosure.remarks}` : "",
    ...disclosure.footnotes.map((note) => `${note.id}: ${note.text}`),
  ].filter(Boolean).join("\n\n");
}

/** Summarize only loaded non-derivative buys/sales, grouped by security. */
export function buildInsiderSummary(parsed: ParsedInsiderFiling[], now = Date.now(), context: readonly ParsedInsiderFiling[] = parsed): string | null {
  if (parsed.some(({ isLoading }) => isLoading)) return null;
  const amendments = buildInsiderAmendmentScopes(context);
  const incomplete = parsed.some((entry) => {
    const { transaction } = entry;
    if (isInsiderDisclosureOnly(entry)) return false;
    return !transaction?.filingDate || transaction.shares == null || !transaction.transactionType || !transaction.securityTitle;
  });
  const cutoff = now - NINETY_DAYS_MS;
  const totals = new Map<string, { security: string; side: string; shares: number; value: number; knownValue: boolean; unreconciled: boolean }>();
  for (const entry of parsed) {
    const { transaction } = entry;
    if (!transaction || transaction.isDerivative || transaction.shares == null || !transaction.securityTitle) continue;
    const date = transaction.filingDate?.getTime();
    if (date == null || !Number.isFinite(date) || date < cutoff || date > now) continue;
    if (transaction.transactionType !== "P" && transaction.transactionType !== "S") continue;
    const security = transaction.securityTitle;
    const key = `${security}:${transaction.transactionType}`;
    const total = totals.get(key) ?? { security, side: transaction.transactionType, shares: 0, value: 0, knownValue: true, unreconciled: false };
    total.unreconciled ||= affectingInsiderAmendments(entry, amendments).length > 0;
    total.shares += transaction.shares;
    total.knownValue &&= transaction.totalValue != null;
    total.value += transaction.totalValue ?? 0;
    totals.set(key, total);
  }
  const prefix = "Loaded filings, last 90 days: ";
  const coverage = incomplete ? " | Some transactions unavailable or incomplete." : "";
  if (totals.size === 0) return `${prefix}no parsed non-derivative buys/sales.${coverage}`;
  return prefix + [...totals.values()].map((total) => total.unreconciled
    ? `${total.security}: ${total.side === "P" ? "Buy" : "Sale"} total unavailable (unreconciled amendment)`
    : `${total.security}: ${total.side === "P" ? "Bought" : "Sold"} ${formatCompact(total.shares)} shares (${total.knownValue ? formatCurrency(total.value) : "value unavailable"})`).join(" | ") + coverage;
}

export function buildInsiderRows(parsed: readonly ParsedInsiderFiling[], context: readonly ParsedInsiderFiling[] = parsed) {
  const scopes = buildInsiderAmendmentScopes(context);
  return parsed.map((entry) => {
    const { filing, transaction, isLoading } = entry;
    const amendments = affectingInsiderAmendments(entry, scopes);
    return {
      id: insiderTransactionId(entry),
      filingDate: filing.filingDate instanceof Date ? filing.filingDate.toISOString() : String(filing.filingDate),
      transactionDate: transaction?.filingDate?.toISOString() ?? null,
      insider: insiderReportedName(entry),
      reportingOwners: entry.disclosure?.reportingOwners ?? transaction?.reportingOwners ?? [],
      title: transaction?.title ?? (entry.disclosure?.reportingOwners.map((owner) => owner.title).filter(Boolean).join("; ") || null),
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
      documentForm: entry.disclosure?.form ?? transaction?.form ?? null,
      isAmendment: isAmendedInsiderFiling(entry),
      amendmentStatus: isAmendedInsiderFiling(entry) ? "unreconciled" : amendments.length ? "potentially-amended" : null,
      relatedAmendments: amendments.map((scope) => scope.accessionNumber),
      originalFilingDate: entry.disclosure?.originalFilingDate ?? null,
      footnotes: entry.disclosure?.footnotes ?? [],
      transactionFootnoteIds: transaction?.footnoteIds ?? [],
      remarks: entry.disclosure?.remarks ?? null,
      accessionNumber: filing.accessionNumber,
      url: filing.filingUrl,
      status: isLoading ? "loading" : !transaction ? isInsiderDisclosureOnly(entry) ? "disclosure" : "unavailable" : transaction.filingDate && transaction.shares != null && transaction.transactionType && transaction.securityTitle ? "parsed" : "partial",
    };
  });
}
