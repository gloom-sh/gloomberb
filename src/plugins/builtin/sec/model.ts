import type { SecFilingItem } from "../../../types/data-provider";
import { secFilingItemCodes } from "../../../utils/sec";

function getDisplayFormLabel(form: string): string {
  const trimmed = form.trim();
  return /^\d+(?:\/[A-Z])?$/i.test(trimmed)
    ? `FORM ${trimmed}`
    : trimmed;
}

function normalizeComparableText(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bFORM\b/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripRedundantFormPrefix(form: string, description: string): string {
  const pattern = escapeRegExp(form.trim()).replace(/\s+/g, "\\s+");
  return description
    .trim()
    .replace(new RegExp(`^(?:FORM\\s+)?${pattern}(?:\\s*[:|–—-]\\s*|\\s+)`, "i"), "")
    .trim();
}

export function getMeaningfulPrimaryDescription(filing: SecFilingItem): string | undefined {
  const description = filing.primaryDocDescription?.trim();
  if (!description) return undefined;
  if (normalizeComparableText(description) === normalizeComparableText(filing.form)) return undefined;
  // Fund filers often describe every document with their own name.
  if (filing.companyName && normalizeComparableText(description) === normalizeComparableText(filing.companyName)) return undefined;

  const stripped = stripRedundantFormPrefix(filing.form, description);
  if (!stripped) return undefined;
  if (normalizeComparableText(stripped) === normalizeComparableText(filing.form)) return undefined;
  return stripped;
}

export function getFilingDisplayTitle(filing: SecFilingItem): string {
  const description = getMeaningfulPrimaryDescription(filing);
  const formLabel = getDisplayFormLabel(filing.form);
  return description ? `${formLabel} | ${description}` : formLabel;
}

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
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Exhibits",
};

const isCurrentReport = (form: string) => /^(?:8-K|6-K)(?:\/A)?$/i.test(form.trim());

/** `Results of operations; Exhibits` from `2.02,9.01`; exhibits only when nothing else is reported. */
function currentReportItemsText(items: string | null | undefined): string | null {
  const codes = (secFilingItemCodes(items) ?? "").split(",").filter(Boolean);
  const named = codes.filter((code) => code !== "9.01" || codes.length === 1).map((code) => CURRENT_REPORT_ITEMS[code] ?? `Item ${code}`);
  return named.length > 0 ? named.join("; ") : null;
}

/**
 * The period a 10-K or 10-Q covers, read from its inline XBRL document name
 * (`aapl-20260627.htm`), which by convention carries the period end. A date
 * after the filing, or more than 15 months before it, is not taken.
 */
function periodicReportPeriod(filing: Pick<SecFilingItem, "form" | "primaryDocument" | "filingDate">): string | null {
  if (!/^(?:10-K|10-Q|10-KT|10-QT|20-F|40-F)(?:\/A)?$/i.test(filing.form.trim())) return null;
  const match = /^[a-z0-9.]+-(\d{4})(\d{2})(\d{2})(?:x\d+)?\.html?$/i.exec(filing.primaryDocument?.split("/").pop() ?? "");
  if (!match) return null;
  const end = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const filed = new Date(filing.filingDate).getTime();
  if (!Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10) !== iso || !Number.isFinite(filed)) return null;
  const days = (filed - end.getTime()) / 86_400_000;
  return days >= 0 && days <= 460 ? iso : null;
}

/** The adjacent FORM column already identifies the form. Keep its meaning here: what the filing reports. */
export function getFilingColumnText(filing: SecFilingItem): string {
  const description = getMeaningfulPrimaryDescription(filing);
  const meaning = getFormDescription(filing.form);
  if (!description) {
    const items = isCurrentReport(filing.form) ? currentReportItemsText(filing.items) : null;
    if (items) return /\/A$/i.test(filing.form.trim()) ? `${items} (amended)` : items;
    const period = periodicReportPeriod(filing);
    if (period) return `${meaning || "Report"}, period ended ${period}`;
    return meaning || "Filing";
  }
  return meaning && normalizeComparableText(description) !== normalizeComparableText(meaning)
    ? `${description} | ${meaning}`
    : description;
}

export function getFormDescription(form: string): string {
  const normalized = form.trim().toUpperCase();
  switch (normalized) {
    case "10-K": return "Annual Report";
    case "10-K/A": return "Annual Report (Amended)";
    case "10-Q": return "Quarterly Report";
    case "10-Q/A": return "Quarterly Report (Amended)";
    case "8-K": return "Current Report";
    case "8-K/A": return "Current Report (Amended)";
    case "8-K12B": return "Successor Issuer Current Report";
    case "S-4": return "Business Combination or Exchange Offer Registration";
    case "S-4/A": return "Business Combination or Exchange Offer Registration (Amended)";
    case "4": return "Insider Transaction";
    case "3": return "Initial Insider Ownership";
    case "5": return "Annual Insider Ownership";
    case "144": return "Notice of proposed sale of securities";
    case "144/A": return "Notice of proposed sale of securities (Amended)";
    case "SC 13G":
    case "SCHEDULE 13G": return "Beneficial Ownership (Passive)";
    case "SC 13G/A":
    case "SCHEDULE 13G/A": return "Beneficial Ownership (Passive, Amended)";
    case "SC 13D":
    case "SCHEDULE 13D": return "Beneficial Ownership (Active)";
    case "SC 13D/A":
    case "SCHEDULE 13D/A": return "Beneficial Ownership (Active, Amended)";
    case "DEF 14A": return "Proxy Statement";
    case "S-1": return "Registration Statement";
    case "20-F": return "Annual Report (Foreign)";
    case "N-1A": return "Fund Registration Statement";
    case "N-2": return "Closed-End Fund Registration Statement";
    case "485APOS":
    case "485BPOS": return "Post-Effective Amendment";
    case "485BXT": return "Effective Date Extension";
    case "497": return "Prospectus Supplement";
    case "497J": return "Prospectus Certification";
    case "497K": return "Summary Prospectus";
    case "N-CSR": return "Certified Shareholder Report";
    case "N-CSRS": return "Certified Shareholder Report (Semiannual)";
    case "N-30D": return "Shareholder Report";
    case "N-CEN": return "Annual Report for Registered Investment Companies";
    case "NPORT-P": return "Monthly Portfolio Holdings Report";
    case "NPORT-EX": return "Portfolio Holdings Exhibit";
    case "24F-2NT": return "Annual Notice of Securities Sold";
    case "SD": return "Conflict Minerals Report";
    case "S-3": return "Shelf Registration";
    case "S-8": return "Employee Plan Registration";
    case "FWP": return "Free Writing Prospectus";
    case "DEFA14A": return "Additional Proxy Materials";
    case "PX14A6G": return "Shareholder Exempt Solicitation";
    case "11-K": return "Employee Plan Annual Report";
    case "ARS": return "Annual Report to Shareholders";
    case "NT 10-K": return "Late Annual Report Notice";
    case "NT 10-Q": return "Late Quarterly Report Notice";
    case "25-NSE": return "Delisting Notice";
    case "6-K": return "Foreign Issuer Current Report";
    case "40-F": return "Annual Report (Canadian)";
    case "424B2":
    case "424B3":
    case "424B5": return "Prospectus";
    default: {
      const base = normalized.endsWith("/A") ? getFormDescription(normalized.slice(0, -2)) : "";
      return base ? `${base} (Amended)` : "";
    }
  }
}

/** The groups of the Form filter: a reader looks for reports, events or insiders, not one form code. */
export interface FormGroup {
  value: string;
  label: string;
  matches: (form: string) => boolean;
}

const upper = (form: string) => form.trim().toUpperCase().replace(/\/A$/, "");
const oneOf = (...forms: string[]) => (form: string) => forms.includes(upper(form));

export const ALL_FORMS = "all";

export const COMPANY_FORM_GROUPS: readonly FormGroup[] = [
  { value: "periodic", label: "Annual & quarterly", matches: oneOf("10-K", "10-Q", "10-KT", "10-QT", "20-F", "40-F", "NT 10-K", "NT 10-Q", "NT 20-F") },
  { value: "current", label: "Current reports", matches: (form) => isCurrentReport(form) || upper(form) === "8-K12B" },
  { value: "insider", label: "Insider", matches: oneOf("3", "4", "5", "144") },
  { value: "ownership", label: "13D / 13G", matches: (form) => /^(?:SC|SCHEDULE) 13[DG]$/.test(upper(form)) },
  { value: "proxy", label: "Proxy", matches: (form) => /^(?:DEF|DEFA|DEFM|PRE|PREM|DFAN)14[AC]$/.test(upper(form).replace(/\s+/g, "")) },
  { value: "offerings", label: "Registrations & offerings", matches: (form) => /^(?:S-\d|F-\d|424B\d|FWP|S-8 POS|POS AM|425)/.test(upper(form)) },
];

export const FUND_FORM_GROUPS: readonly FormGroup[] = [
  { value: "reports", label: "Shareholder reports", matches: oneOf("N-CSR", "N-CSRS", "N-30D") },
  { value: "holdings", label: "Holdings", matches: oneOf("NPORT-P", "NPORT-EX") },
  { value: "prospectus", label: "Prospectus & registration", matches: oneOf("N-1A", "N-2", "485APOS", "485BPOS", "485BXT", "497", "497J", "497K") },
  { value: "census", label: "Flows & census", matches: oneOf("N-CEN", "24F-2NT") },
];

/** Filings in a group; `all` and an unknown group keep every filing. */
export function filterFilingsByGroup<T extends { form: string }>(filings: readonly T[], groups: readonly FormGroup[], value: string): T[] {
  const group = groups.find((entry) => entry.value === value);
  return group ? filings.filter((filing) => group.matches(filing.form)) : [...filings];
}

export type FilingTone = "positive" | "negative" | "warning" | "accent" | "muted" | "text";

/**
 * How much a filing matters, in the tone every research pane gives a state:
 * events that can sink a company (bankruptcy, delisting, non-reliance, a late
 * report) red, an insider sale red and a purchase green, a planned sale, an
 * activist stake, a management or auditor change amber, the periodic reports,
 * earnings and fund shareholder reports in the accent, and routine paperwork
 * quiet. A fund's annual notice of securities sold reads green for a year of
 * net creations and red for net redemptions. The form text never changes, so
 * the colour is not the only signal.
 */
export function filingTone(filing: Pick<SecFilingItem, "form" | "items">, insiderDirection?: "buy" | "sell" | null): FilingTone {
  const form = upper(filing.form);
  if (/^NT /.test(form)) return "negative";
  if (isCurrentReport(filing.form)) {
    const codes = (secFilingItemCodes(filing.items) ?? "").split(",");
    if (codes.some((code) => code === "1.03" || code === "3.01" || code === "4.02")) return "negative";
    if (codes.some((code) => ["2.05", "2.06", "4.01", "5.01", "5.02", "1.05"].includes(code))) return "warning";
    if (codes.includes("2.02")) return "accent";
    return "text";
  }
  if (form === "4" || form === "5" || form === "24F-2NT") return insiderDirection === "sell" ? "negative" : insiderDirection === "buy" ? "positive" : form === "24F-2NT" ? "muted" : "text";
  if (form === "144") return "warning";
  if (/13D$/.test(form)) return "warning";
  if (/^(?:10-K|10-Q|10-KT|10-QT|20-F|40-F|N-CSR|N-CSRS|N-30D|N-1A|N-2)$/.test(form)) return "accent";
  if (/^(?:3|SC 13G|SCHEDULE 13G|SD|497|497J|497K|485BPOS|485BXT|NPORT-P|NPORT-EX)$/.test(form)) return "muted";
  return "text";
}

export function buildSecFilingRows(filings: readonly SecFilingItem[]) {
  return filings.map((filing) => {
    return {
      filedAt: filing.filingDate instanceof Date
        ? filing.filingDate.toISOString()
        : String(filing.filingDate),
      acceptedAt: secAcceptanceTimestamp(filing.acceptedAt),
      acceptedAtRaw: filing.acceptedAtRaw ?? null,
      acceptanceReported: secReportedAcceptance(filing),
      form: filing.form,
      filing: getFilingColumnText(filing),
      items: secFilingItemCodes(filing.items),
      accessionNumber: filing.accessionNumber,
      primaryDocument: filing.primaryDocument ?? null,
      cik: filing.cik,
      companyName: filing.companyName ?? null,
      url: filing.filingUrl,
    };
  });
}

export function secFilingIssuers(filings: readonly SecFilingItem[]) {
  const issuers = new Map<string, { cik: string; companyName: string | null }>();
  for (const filing of filings) {
    const previous = issuers.get(filing.cik);
    if (!previous || (!previous.companyName && filing.companyName)) {
      issuers.set(filing.cik, { cik: filing.cik, companyName: filing.companyName ?? null });
    }
  }
  return [...issuers.values()];
}

export function secIssuerLabel(issuer: { cik: string; companyName?: string | null }): string {
  return `${issuer.companyName || "Issuer name unavailable"} · CIK ${issuer.cik}`;
}

/** Persistence may return timestamps as strings even when the network model uses Date. */
export function secAcceptanceTimestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function secReportedAcceptance(filing: SecFilingItem): string | null {
  const persistedValue: unknown = filing.acceptedAt;
  const raw = filing.acceptedAtRaw?.trim() || (typeof persistedValue === "string" ? persistedValue.trim() : undefined);
  if (raw) return /^\d{14}$/.test(raw) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
    ? `${raw} (timezone unspecified)`
    : raw;
  return secAcceptanceTimestamp(filing.acceptedAt);
}

export const SEC_ACCEPTANCE_NOTE = "SEC-reported acceptance is not verified public availability or an announcement time. Source timestamps without a timezone remain unconverted.";
