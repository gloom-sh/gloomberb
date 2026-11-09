import type { SecFilingItem } from "../../../types/data-provider";
import { formatCompact, formatCurrencyCode } from "../../../utils/format";
import { parseForm4Xml, parseForm4Disclosure, transactionTypeLabel, type InsiderTransaction, type InsiderFilingDisclosure, type InsiderReportingOwner } from "./insider-data";
import { affectingInsiderAmendments, buildInsiderAmendmentScopes, isAmendedInsiderFiling } from "./amendments";
import { formatInsiderName, isOpenMarketTrade, shortInsiderRole } from "./display";
import { isOtherIssuerFiling } from "./issuer";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface ParsedInsiderFiling {
  filing: SecFilingItem;
  transaction: InsiderTransaction | null;
  isLoading: boolean;
  disclosure?: InsiderFilingDisclosure | null;
}

/** The rows of one filing; none for a Form 4 the company filed as an owner of another issuer. */
export function parseInsiderFiling(filing: SecFilingItem, content: string | null, isLoading = false): ParsedInsiderFiling[] {
  if (isOtherIssuerFiling(filing, content)) return [];
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

/** The reported name as the table shows it, first name first. */
export function insiderDisplayName(entry: ParsedInsiderFiling): string | null {
  const name = insiderReportedName(entry);
  return name ? formatInsiderName(name) : null;
}

function insiderOwners(entry: ParsedInsiderFiling): InsiderReportingOwner[] {
  return entry.disclosure?.reportingOwners ?? entry.transaction?.reportingOwners ?? [];
}

/** The owner's role in a word or two (CEO, Director, 10% owner); the full title stays in the detail. */
export function insiderRole(entry: ParsedInsiderFiling): string {
  const owners = insiderOwners(entry);
  if (owners.length) return shortInsiderRole(owners, entry.disclosure?.remarks);
  return entry.transaction?.title ? shortInsiderRole([{ title: entry.transaction.title }]) : "";
}

/** Matches the name as filed ("COOK TIMOTHY D") or as shown ("Timothy D. Cook"). */
export function matchesInsiderOwner(entry: ParsedInsiderFiling, name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  const matches = (candidate: string | null | undefined) => !!candidate
    && (candidate.toLocaleLowerCase() === normalized || formatInsiderName(candidate).toLocaleLowerCase() === normalized);
  return matches(insiderReportedName(entry)) || insiderOwners(entry).some((owner) => matches(owner.name));
}

/**
 * The Type filter: open-market buys and sells (codes P and S, the default),
 * everything else (awards, exercises, tax withholding, gifts), or all.
 */
export type InsiderTypeFilter = "trades" | "other" | "all";

export const DEFAULT_INSIDER_TYPE_FILTER: InsiderTypeFilter = "trades";

export function isInsiderTypeFilter(value: unknown): value is InsiderTypeFilter {
  return value === "trades" || value === "other" || value === "all";
}

/**
 * Whether a row belongs in a Type view. A filing still being read shows only
 * under All, so the narrower views do not flicker as it resolves. A filing
 * that could not be read, or an amendment without transaction lines, may
 * hide a trade, so it shows under both narrower views.
 */
export function matchesInsiderTypeFilter(entry: ParsedInsiderFiling, filter: InsiderTypeFilter): boolean {
  if (filter === "all") return true;
  const { transaction } = entry;
  if (transaction) return isOpenMarketTrade(transaction.transactionType) === (filter === "trades");
  if (entry.isLoading) return false;
  if (isInsiderDisclosureOnly(entry)) return filter === "other" || isAmendedInsiderFiling(entry);
  return true;
}

export function buildInsiderDisclosureText(entry: ParsedInsiderFiling): string {
  const disclosure = entry.disclosure;
  if (!disclosure) return "";
  return [
    disclosure.remarks ? `Remarks: ${disclosure.remarks}` : "",
    ...disclosure.footnotes.map((note) => `${note.id}: ${note.text}`),
  ].filter(Boolean).join("\n\n");
}

interface InsiderSideTotal {
  security: string;
  side: "P" | "S";
  shares: number;
  value: number;
  knownValue: boolean;
  unreconciled: boolean;
}

export interface InsiderSummaryFigures {
  totals: InsiderSideTotal[];
  /** Some loaded filings could not be read into complete transactions. */
  incomplete: boolean;
}

/** Words a filer adds or leaves out without naming another class: "Common Stock" and "Common" are one. */
const SECURITY_FILLER_WORDS = new Set(["stock", "stocks", "share", "shares"]);

/**
 * One key for every spelling filers give the same class of security: "Common
 * Stock", "Common", "COMMON STOCK, $0.001 PAR VALUE" and "Common Stock, par
 * value $.01 per share" are one class, and so are "Class A Common Stock" and
 * "Common Stock, Class A". Class A and Class B, common and preferred, Series A
 * and Series B stay apart.
 */
export function securityClassKey(title: string): string {
  const words = title.toLowerCase()
    // A par or nominal value tail names the same shares: ", par value $0.0001 per share", "$.01 par value".
    .replace(/(?:[$€£]?\s*\d*\.?\d+\s*)?\b(?:par(?:\s+value)?|nominal\s+value|stated\s+value)\b.*$/, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !SECURITY_FILLER_WORDS.has(word));
  return words.length ? [...new Set(words)].sort().join(" ") : title.trim().toLowerCase();
}

/** Totals of the loaded non-derivative buys and sales in the last 90 days, by class of security and side. */
export function buildInsiderSummaryFigures(parsed: readonly ParsedInsiderFiling[], now = Date.now(), context: readonly ParsedInsiderFiling[] = parsed): InsiderSummaryFigures | null {
  if (parsed.some(({ isLoading }) => isLoading)) return null;
  const amendments = buildInsiderAmendmentScopes(context);
  const incomplete = parsed.some((entry) => {
    const { transaction } = entry;
    if (isInsiderDisclosureOnly(entry)) return false;
    return !transaction?.filingDate || transaction.shares == null || !transaction.transactionType || !transaction.securityTitle;
  });
  const cutoff = now - NINETY_DAYS_MS;
  const totals = new Map<string, InsiderSideTotal>();
  // Shares under each spelling of a class, so a total is named the way most of its shares were filed.
  const spellings = new Map<string, Map<string, number>>();
  for (const entry of parsed) {
    const { transaction } = entry;
    if (!transaction || transaction.isDerivative || transaction.shares == null || !transaction.securityTitle) continue;
    const date = transaction.filingDate?.getTime();
    if (date == null || !Number.isFinite(date) || date < cutoff || date > now) continue;
    if (transaction.transactionType !== "P" && transaction.transactionType !== "S") continue;
    const security = transaction.securityTitle;
    const key = `${securityClassKey(security)}:${transaction.transactionType}`;
    const total = totals.get(key) ?? { security, side: transaction.transactionType, shares: 0, value: 0, knownValue: true, unreconciled: false };
    total.unreconciled ||= affectingInsiderAmendments(entry, amendments).length > 0;
    total.shares += transaction.shares;
    total.knownValue &&= transaction.totalValue != null;
    total.value += transaction.totalValue ?? 0;
    totals.set(key, total);
    const filed = spellings.get(key) ?? new Map<string, number>();
    filed.set(security, (filed.get(security) ?? 0) + transaction.shares);
    spellings.set(key, filed);
  }
  for (const [key, total] of totals) {
    const filed = [...spellings.get(key)!];
    total.security = filed.reduce((best, entry) => (entry[1] > best[1] ? entry : best), filed[0]!)[0];
  }
  return { totals: [...totals.values()], incomplete };
}

/** The oldest filing date that the 90-day totals need loaded before they cover the whole window. */
export function insiderSummaryCutoff(now = Date.now()): number {
  return now - NINETY_DAYS_MS;
}

/** Summarize only loaded non-derivative buys/sales, grouped by security. */
export function buildInsiderSummary(parsed: ParsedInsiderFiling[], now = Date.now(), context: readonly ParsedInsiderFiling[] = parsed): string | null {
  const figures = buildInsiderSummaryFigures(parsed, now, context);
  if (!figures) return null;
  const prefix = "Loaded filings, last 90 days: ";
  const coverage = figures.incomplete ? " | Some transactions unavailable or incomplete." : "";
  if (figures.totals.length === 0) return `${prefix}no parsed non-derivative buys/sales.${coverage}`;
  return prefix + figures.totals.map((total) => total.unreconciled
    ? `${total.security}: ${total.side === "P" ? "Buy" : "Sale"} total unavailable (unreconciled amendment)`
    : `${total.security}: ${total.side === "P" ? "Bought" : "Sold"} ${formatCompact(total.shares)} shares (${total.knownValue ? formatCurrencyCode(total.value, "USD") : "value unavailable"})`).join(" | ") + coverage;
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
      insiderName: insiderDisplayName(entry),
      role: insiderRole(entry) || null,
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
      rule10b51: transaction?.rule10b51 ?? null,
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
