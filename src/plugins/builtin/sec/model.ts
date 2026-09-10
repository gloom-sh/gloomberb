import type { SecFilingItem } from "../../../types/data-provider";

export function getDisplayFormLabel(form: string): string {
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
    .replace(new RegExp(`^(?:FORM\\s+)?${pattern}(?:\\s*[:|-]\\s*|\\s+)`, "i"), "")
    .trim();
}

export function getMeaningfulPrimaryDescription(filing: SecFilingItem): string | undefined {
  const description = filing.primaryDocDescription?.trim();
  if (!description) return undefined;
  if (normalizeComparableText(description) === normalizeComparableText(filing.form)) return undefined;

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
    case "SC 13G": return "Beneficial Ownership (Passive)";
    case "SC 13G/A": return "Beneficial Ownership (Amended)";
    case "SC 13D": return "Beneficial Ownership (Active)";
    case "SC 13D/A": return "Beneficial Ownership (Amended)";
    case "DEF 14A": return "Proxy Statement";
    case "S-1": return "Registration Statement";
    case "20-F": return "Annual Report (Foreign)";
    default: return "";
  }
}

export function buildSecFilingRows(filings: readonly SecFilingItem[]) {
  return filings.map((filing) => {
    const displayTitle = getFilingDisplayTitle(filing);
    const formDescription = getFormDescription(filing.form);
    return {
      filedAt: filing.filingDate instanceof Date
        ? filing.filingDate.toISOString()
        : String(filing.filingDate),
      acceptedAt: secAcceptanceTimestamp(filing.acceptedAt),
      acceptedAtRaw: filing.acceptedAtRaw ?? null,
      acceptanceReported: secReportedAcceptance(filing),
      form: filing.form,
      filing: formDescription ? `${displayTitle} | ${formDescription}` : displayTitle,
      items: filing.items ?? null,
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
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function secReportedAcceptance(filing: SecFilingItem): string | null {
  const raw = filing.acceptedAtRaw?.trim();
  if (raw) return /^\d{14}$/.test(raw) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
    ? `${raw} (timezone unspecified)`
    : raw;
  return secAcceptanceTimestamp(filing.acceptedAt);
}

export const SEC_ACCEPTANCE_NOTE = "SEC-reported acceptance is not verified public availability or an announcement time. Source timestamps without a timezone remain unconverted.";
