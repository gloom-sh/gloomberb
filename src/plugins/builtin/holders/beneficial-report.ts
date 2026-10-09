import type { BeneficialOwnersCoverage, BeneficialOwnersForm, BeneficialOwnersPayload } from "../../../api-client/beneficial-owners";
import type { HolderData } from "../../../types/financials";
import {
  beneficialReportRow,
  buildBeneficialRows,
  DEFAULT_BENEFICIAL_SORT,
  formatClassPercent,
  formatOwnerShares,
  formatPointChange,
  stakeMarker,
  sortBeneficialRows,
  type BeneficialReportRow,
  type BeneficialSortPreference,
} from "./beneficial-model";
import { buildRows } from "./table-model";

/** What `holders --form` lists: the 13F table, or the 13D/13G beneficial owners. */
export type HolderForm = "13f" | "13d" | "13g" | "all";
export const HOLDER_FORMS: readonly HolderForm[] = ["13f", "13d", "13g", "all"];

export function parseHolderForm(value: unknown): HolderForm | null {
  const form = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (HOLDER_FORMS as readonly string[]).includes(form) ? form as HolderForm : null;
}

export function beneficialRouteForm(form: Exclude<HolderForm, "13f">): BeneficialOwnersForm {
  return form === "13d" ? "13D" : form === "13g" ? "13G" : "all";
}

/** Text columns for the 13D/13G rows; CSV and JSON keep the raw values. */
export const BENEFICIAL_REPORT_COLUMNS = [
  { key: "filer", header: "Filer", maxWidth: 32 },
  { key: "form", header: "Form" },
  {
    key: "percentOfClass",
    header: "% Class",
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => {
      const marker = stakeMarker(row.status === "below-threshold" || row.status === "exited" ? row.status : null);
      if (typeof value !== "number") return marker || "-";
      return marker ? `${formatClassPercent(value)} ${marker}` : formatClassPercent(value);
    },
  },
  {
    key: "changePoints",
    header: "Chg",
    align: "right" as const,
    format: (value: unknown) => formatPointChange(typeof value === "number" ? value : null),
  },
  {
    key: "shares",
    header: "Shares",
    align: "right" as const,
    format: (value: unknown) => formatOwnerShares(typeof value === "number" ? value : null),
  },
  { key: "eventDate", header: "Event", format: (value: unknown) => typeof value === "string" ? value : "-" },
  { key: "filingDate", header: "Filed" },
  { key: "thirteenF", header: "13F", align: "right" as const, format: (value: unknown) => typeof value === "string" ? value : "-" },
];

const filings = (count: number) => `${count} ${count === 1 ? "filing" : "filings"}`;

/**
 * What the list leaves out, a sentence each: reports that could not be read
 * this time, and reports known only from the EDGAR index whose figures are
 * blank.
 */
export function beneficialCoverageNotices(coverage: BeneficialOwnersCoverage | null | undefined): string[] {
  if (!coverage) return [];
  const notices: string[] = [];
  if (coverage.unavailable) {
    notices.push(`${coverage.unavailable} of ${filings(coverage.filings)} could not be read this time and are left out, so a filer's row may not be its latest report; a refresh retries them.`);
  }
  // Reports that could not be read count as unparsed too.
  const indexOnly = Math.max(0, coverage.unparsed - (coverage.unavailable ?? 0));
  if (indexOnly) {
    notices.push(`Percent of class and shares are blank for ${filings(indexOnly)} known only from the EDGAR index.`);
  }
  return notices;
}

/** What the list covers, for the line above it: `13D/13G filings since 2022-10-09`, `11 filers`. */
export function beneficialListFacts(
  payload: Pick<BeneficialOwnersPayload, "coverage">,
  form: Exclude<HolderForm, "13f">,
  rows: number,
  history: boolean,
): string[] {
  const kind = form === "all" ? "13D/13G" : form.toUpperCase();
  const since = payload.coverage?.from ? `${kind} filings since ${payload.coverage.from}` : `${kind} filings`;
  const count = history ? `${rows} ${rows === 1 ? "report" : "reports"}` : `${rows} ${rows === 1 ? "filer" : "filers"}`;
  return [since, count];
}

/** Every page loaded and every filing in the window read. */
export function beneficialListComplete(payload: Pick<BeneficialOwnersPayload, "hasMore" | "coverage">): boolean {
  return !payload.hasMore && !payload.coverage?.unavailable && payload.coverage?.complete !== false;
}

/** No rows although filings are listed: they could not be read, which is not the same as none filed. */
export function beneficialListUnreadable(payload: Pick<BeneficialOwnersPayload, "owners" | "coverage">): boolean {
  return payload.owners.length === 0 && (payload.coverage?.filings ?? 0) > 0;
}

/**
 * The rows `--form 13d|13g|all` prints: the latest report per filer by
 * percent of class, stakes under 5% and exits after the 5% holders, or with `history` every report
 * newest first. The 13F action joins by name to the 13F holders when they
 * loaded; a report without one shows none.
 */
export function buildBeneficialReportRows(
  payload: BeneficialOwnersPayload,
  {
    history = false,
    holders = null,
    sort = DEFAULT_BENEFICIAL_SORT,
  }: { history?: boolean; holders?: HolderData | null; sort?: BeneficialSortPreference } = {},
): BeneficialReportRow[] {
  const holderRows = buildRows(holders);
  if (history) {
    const filings = [...(payload.filings ?? payload.owners)]
      .sort((left, right) => right.filingDate.localeCompare(left.filingDate));
    return buildBeneficialRows(filings, holderRows).map(beneficialReportRow);
  }
  return sortBeneficialRows(buildBeneficialRows(payload.owners, holderRows), sort).map(beneficialReportRow);
}
