import type { SecFilingItem } from "../../../types/data-provider";

/**
 * Registered fund forms: registration statements and their post-effective
 * amendments, prospectus supplements, shareholder reports, the annual census
 * and monthly portfolio reports. An amendment (`N-CSR/A`) matches its form.
 */
export const ETF_FILING_FORMS = [
  "N-1A",
  "N-2",
  "485APOS",
  "485BPOS",
  "485BXT",
  "497",
  "497J",
  "497K",
  "N-CSR",
  "N-CSRS",
  "N-30D",
  "N-CEN",
  "NPORT-P",
  "NPORT-EX",
  "24F-2NT",
] as const;

export const ETF_FORMS_SETTING = ETF_FILING_FORMS.join(",");

/**
 * How many filings the SEC pane asks for: the most the filings service
 * returns for one issuer. A form filter searches only these, so when an issuer
 * has this many, older matching filings may exist.
 */
export const SEC_FILING_FETCH_LIMIT = 20_000;

function normalizeFilingForm(form: string): string {
  return form.trim().toUpperCase();
}

/** Empty means no form filter. The unfiltered SEC template relies on that. */
export function parseFormsSetting(value: string | undefined): string[] | null {
  const forms = (value ?? "")
    .split(",")
    .map((part) => normalizeFilingForm(part))
    .filter(Boolean);
  return forms.length > 0 ? forms : null;
}

export function filterFilingsByForms(filings: readonly SecFilingItem[], forms: readonly string[]): SecFilingItem[] {
  const accepted = new Set(forms.map(normalizeFilingForm));
  return filings.filter((filing) => {
    const form = normalizeFilingForm(filing.form);
    return accepted.has(form) || (form.endsWith("/A") && accepted.has(form.slice(0, -2)));
  });
}

/** A form as typed or filed, without punctuation or the `SC`/`SCHEDULE` prefix of ownership schedules. */
function compactFilingForm(form: string): string {
  return form.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(?:SCHEDULE|SC)(?=\d)/, "");
}

/** `13D` matches SC 13D, SCHEDULE 13D and their amendments; `10-K` matches 10-K and 10-K/A. */
export function filingFormMatches(form: string, wanted: string): boolean {
  const target = compactFilingForm(wanted);
  const actual = compactFilingForm(form);
  return !!target && (actual === target || actual === `${target}A`);
}
