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

/** A 13D or 13G beneficial-ownership schedule or its amendment, under the old (`SC 13G`) or current (`SCHEDULE 13G`) form name. */
function isOwnershipSchedule(form: string): boolean {
  return /^(?:SC|SCHEDULE) 13[DG](?:\/A)?$/i.test(form.trim());
}

/**
 * A 13D or 13G the company filed as a holder of another company's shares.
 * EDGAR lists a schedule under its filer as well as its subject, so a bank's
 * or an asset manager's list holds hundreds about other companies (197 of
 * JPM's last 199), and only one about the company carries its 005- file
 * number. Who submitted it does not tell: an agent files both kinds. A
 * filing whose file number the source did not give is kept.
 */
export function isScheduleAboutAnotherCompany(filing: Pick<SecFilingItem, "form" | "fileNumber">): boolean {
  return typeof filing.fileNumber === "string" && isOwnershipSchedule(filing.form) && !/^005-/.test(filing.fileNumber.trim());
}

/** The filings a short list left out, by kind. */
export interface HiddenFilings {
  pricingSupplements: number;
  /** The 13D/13G the company filed as a holder of other companies. */
  ownershipReportsAboutOthers: number;
}

/**
 * The first `limit` filings that are not left out, and how many of each kind
 * sat among them: those filed since the last filing kept, or all of them when
 * fewer than `limit` are kept.
 */
function keptFilings(
  filings: readonly SecFilingItem[],
  limit: number,
  schedulesAboutOthers: boolean,
): { filings: SecFilingItem[]; hidden: HiddenFilings } {
  const kept: SecFilingItem[] = [];
  const hidden: HiddenFilings = { pricingSupplements: 0, ownershipReportsAboutOthers: 0 };
  for (const filing of filings) {
    if (kept.length >= limit) break;
    if (isPricingSupplement(filing)) hidden.pricingSupplements += 1;
    else if (schedulesAboutOthers && isScheduleAboutAnotherCompany(filing)) hidden.ownershipReportsAboutOthers += 1;
    else kept.push(filing);
  }
  return { filings: kept, hidden };
}

/**
 * "28 pricing supplements and 22 ownership reports about other companies
 * hidden, --all to show", or null when nothing was.
 */
export function hiddenFilingsNote(hidden: HiddenFilings): string | null {
  const count = (value: number, one: string, many: string) =>
    value > 0 ? `${value.toLocaleString("en-US")} ${value === 1 ? one : many}` : null;
  const parts = [
    count(hidden.pricingSupplements, "pricing supplement", "pricing supplements"),
    count(hidden.ownershipReportsAboutOthers, "ownership report about another company", "ownership reports about other companies"),
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? `${parts.join(" and ")} hidden, --all to show` : null;
}

/** Filings asked for first, a few times the rows wanted: supplements come in runs of dozens. */
const FIRST_READ_MIN = 200;
/** A read that leaves the list short is followed by one this many times larger. */
const READ_GROWTH = 5;

/**
 * An issuer's latest `limit` filings without its pricing supplements and,
 * with `schedulesAboutOthers`, the 13D/13G it filed as a holder of other
 * companies. A bank's last hundreds of filings can be nearly all of these
 * (192 of WFC's last 200 are supplements), so a first read asks for a few
 * hundred, and each read that leaves the list short is followed by a five
 * times larger one, up to the issuer in full.
 */
export async function loadLatestFilings(
  load: (count: number) => Promise<SecFilingItem[]>,
  limit: number,
  { schedulesAboutOthers = false }: { schedulesAboutOthers?: boolean } = {},
): Promise<{ filings: SecFilingItem[]; hidden: HiddenFilings }> {
  let count = Math.min(SEC_FILING_FETCH_LIMIT, Math.max(FIRST_READ_MIN, limit * 4));
  for (;;) {
    const read = await load(count);
    const kept = keptFilings(read, limit, schedulesAboutOthers);
    if (kept.filings.length >= limit || read.length < count || count >= SEC_FILING_FETCH_LIMIT) return kept;
    count = Math.min(SEC_FILING_FETCH_LIMIT, count * READ_GROWTH);
  }
}
