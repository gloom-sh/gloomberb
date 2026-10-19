import type { SecFilingItem } from "../types/data-provider";
import { secFilingItemCodes } from "./sec";

/**
 * How many filings a full list asks for: the most the filings service
 * returns for one issuer. A filter searches only these, so when an issuer has
 * this many, older matching filings may exist.
 */
export const SEC_FILING_FETCH_LIMIT = 20_000;

/**
 * 8-K items in a few words, as a reader scans them: what happened, not the
 * SEC's full caption. 9.01 (exhibits) comes with most reports and says little.
 */
const CURRENT_REPORT_ITEMS: Record<string, string> = {
  "1.01": "Material agreement",
  "1.02": "Agreement terminated",
  "1.03": "Bankruptcy or receivership",
  "1.04": "Mine safety",
  "1.05": "Cybersecurity incident",
  "2.01": "Acquisition or disposal",
  "2.02": "Results of operations",
  "2.03": "New financial obligation",
  "2.04": "Obligation accelerated",
  "2.05": "Exit or restructuring costs",
  "2.06": "Impairment",
  "3.01": "Listing standard notice",
  "3.02": "Unregistered equity sale",
  "3.03": "Shareholder rights modified",
  "4.01": "Auditor change",
  "4.02": "Non-reliance on financials",
  "5.01": "Change in control",
  "5.02": "Officer or director change",
  "5.03": "Charter or bylaws amended",
  "5.04": "Benefit plan trading suspension",
  "5.05": "Code of ethics change",
  "5.06": "Shell company status change",
  "5.07": "Shareholder vote results",
  "5.08": "Director nominations",
  // An asset-backed issuer's (Regulation AB) events.
  "6.01": "ABS informational material",
  "6.02": "Servicer or trustee change",
  "6.03": "Credit enhancement change",
  "6.04": "Missed required distribution",
  "6.05": "Securities Act update",
  "6.06": "Static pool",
  "6.10": "Alternative ABS filing",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Exhibits",
};

export const isCurrentReportForm = (form: string) => /^(?:8-K|6-K)(?:\/A)?$/i.test(form.trim());

/** The items a current report names, exhibits only when nothing else is reported. */
function reportedItems(items: string | null | undefined): Array<{ code: string; name: string }> {
  const codes = (secFilingItemCodes(items) ?? "").split(",").filter(Boolean);
  return codes.filter((code) => code !== "9.01" || codes.length === 1)
    .map((code) => ({ code, name: CURRENT_REPORT_ITEMS[code] ?? `Item ${code}` }));
}

/** `Results of operations; Regulation FD disclosure` from `2.02,7.01,9.01`. */
export function currentReportItemNames(items: string | null | undefined): string | null {
  const named = reportedItems(items).map((item) => item.name);
  return named.length > 0 ? named.join("; ") : null;
}

/**
 * `2.02 Results of operations; 7.01 Regulation FD disclosure` from
 * `2.02,7.01,9.01`: the items with their numbers, for a list with no column
 * of its own that says what a filing reports, so the earnings 8-K reads apart
 * from another 8-K filed the same day.
 */
export function currentReportItemsLabel(items: string | null | undefined): string | null {
  const named = reportedItems(items).map((item) => `${item.code} ${item.name}`);
  return named.length > 0 ? named.join("; ") : null;
}

/**
 * The pricing supplements and term sheets of the notes an issuer sells off
 * its shelf: a bank files one for each structured note, hundreds a week
 * (JPM, WFC), as a 424B2 or a free writing prospectus. Another 424B
 * prospectus counts when it calls itself one; a 424B3 is otherwise often a
 * merger or resale prospectus, which stays.
 */
export function isPricingSupplement(filing: Pick<SecFilingItem, "form" | "primaryDocDescription">): boolean {
  const form = filing.form.trim().toUpperCase().replace(/\/A$/, "");
  if (form === "424B2" || form === "FWP") return true;
  return /^424B\d$/.test(form) && /\b(?:PRICING SUPPLEMENT|TERM SHEET)\b/i.test(filing.primaryDocDescription ?? "");
}

/**
 * The first `limit` filings that are not pricing supplements, and how many
 * supplements sat among them: those filed since the last filing kept, or all
 * of them when fewer than `limit` are kept.
 */
function withoutPricingSupplements<T extends Pick<SecFilingItem, "form" | "primaryDocDescription">>(
  filings: readonly T[],
  limit = Number.POSITIVE_INFINITY,
): { filings: T[]; hidden: number } {
  const kept: T[] = [];
  let hidden = 0;
  for (const filing of filings) {
    if (kept.length >= limit) break;
    if (isPricingSupplement(filing)) hidden += 1;
    else kept.push(filing);
  }
  return { filings: kept, hidden };
}

/** "176 pricing supplements hidden, --all to show", or null when none were. */
export function pricingSupplementsNote(hidden: number, show = "--all to show"): string | null {
  if (hidden <= 0) return null;
  return `${hidden.toLocaleString("en-US")} pricing ${hidden === 1 ? "supplement" : "supplements"} hidden, ${show}`;
}

/** Filings asked for first, a few times the rows wanted: supplements come in runs of dozens. */
const FIRST_READ_MIN = 200;

/**
 * An issuer's latest `limit` filings without its pricing supplements. A
 * bank's last hundreds of filings can be nearly all supplements (192 of
 * WFC's last 200), so a first read asks for a few hundred and only an issuer
 * they leave short is read in full.
 */
export async function loadWithoutPricingSupplements(
  load: (count: number) => Promise<SecFilingItem[]>,
  limit: number,
): Promise<{ filings: SecFilingItem[]; hidden: number }> {
  const count = Math.min(SEC_FILING_FETCH_LIMIT, Math.max(FIRST_READ_MIN, limit * 4));
  const first = await load(count);
  const kept = withoutPricingSupplements(first, limit);
  if (kept.filings.length >= limit || first.length < count) return kept;
  return withoutPricingSupplements(await load(SEC_FILING_FETCH_LIMIT), limit);
}
