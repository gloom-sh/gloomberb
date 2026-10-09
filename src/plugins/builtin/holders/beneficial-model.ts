import type { BeneficialOwnerFiling, BeneficialOwnerStatus } from "../../../api-client/beneficial-owners";
import type { DataTableColumn } from "../../../components";
import type { HolderRecord } from "../../../types/financials";
import { clipToDisplayWidth, displayWidth, formatCompact } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { matchFilerToHolder, type Holder13FMatch } from "./thirteenf-match";

export type BeneficialColumnId =
  | "filer"
  | "form"
  | "percentOfClass"
  | "change"
  | "shares"
  | "eventDate"
  | "filingDate"
  | "thirteenF";
export type BeneficialColumn = DataTableColumn & { id: BeneficialColumnId };

export interface BeneficialSortPreference {
  columnId: BeneficialColumnId;
  direction: SortDirection;
}

export const DEFAULT_BENEFICIAL_SORT: BeneficialSortPreference = { columnId: "percentOfClass", direction: "desc" };

/** What the filer did in its latest 13F against the quarter before. */
export interface ThirteenFAction {
  label: string;
  /** The share change as a fraction of the prior position: NEW sorts first, EXIT is -1. */
  value: number;
}

export interface BeneficialOwnerRow {
  id: string;
  filing: BeneficialOwnerFiling;
  /** `13G/A`: the kind, and `/A` for an amendment. */
  formLabel: string;
  /** Percent points against the filer's report before this one. */
  changePoints: number | null;
  thirteenF: ThirteenFAction | null;
  /** The stake the report discloses; null when the report gives neither a percentage nor shares. */
  stake: BeneficialOwnerStatus | null;
}

/** Holder rows the 13F join reads: the Table tab's rows, keyed by their id. */
type JoinableHolder = HolderRecord & { id: string };

/** The Schedule 13D/13G reporting threshold, in percent of the class. */
const REPORTING_THRESHOLD = 5;

/**
 * The stake a report discloses, from its own figures first. A stake under 5%
 * is still a stake; only a report of 0% or zero shares is an exit. A report
 * with neither figure keeps the route's word for a stake under the
 * threshold, but is never read as an exit.
 */
export function disclosedStake(
  filing: Pick<BeneficialOwnerFiling, "percentOfClass" | "shares" | "status">,
): BeneficialOwnerStatus | null {
  const { percentOfClass: percent, shares } = filing;
  if (percent != null) {
    if (percent === 0) return "exited";
    return percent < REPORTING_THRESHOLD ? "below-threshold" : "holder";
  }
  if (shares === 0) return "exited";
  return filing.status === "holder" || filing.status === "below-threshold" ? filing.status : null;
}

function signedPercent(fraction: number): string {
  const rounded = Math.round(fraction * 100);
  return rounded > 0 ? `+${rounded}%` : rounded < 0 ? `${rounded}%` : "0%";
}

/**
 * The quarter's action from a 13F holder row. A position that grew from
 * nothing is NEW, one reported at zero shares after a sale EXIT; without a
 * reported change it is unknown, never "no change".
 */
export function thirteenFAction(holder: HolderRecord | undefined): ThirteenFAction | null {
  if (!holder) return null;
  const { shares, changeShares, changePercent } = holder;
  if (shares === 0 && changeShares != null && changeShares < 0) return { label: "EXIT", value: -1 };
  if (shares != null && changeShares != null) {
    const prior = shares - changeShares;
    if (changeShares > 0 && prior === 0) return { label: "NEW", value: Number.POSITIVE_INFINITY };
    if (prior > 0) return { label: signedPercent(changeShares / prior), value: changeShares / prior };
  }
  if (changePercent != null && Number.isFinite(changePercent)) {
    // The Table tab reads a provider's change the same way: a fraction up to 1, percent points above.
    const fraction = Math.abs(changePercent) <= 1 ? changePercent : changePercent / 100;
    return { label: signedPercent(fraction), value: fraction };
  }
  return null;
}

function beneficialFormLabel(filing: Pick<BeneficialOwnerFiling, "kind" | "amendment">): string {
  return `${filing.kind}${filing.amendment ? "/A" : ""}`;
}

function pointChange(filing: BeneficialOwnerFiling): number | null {
  if (filing.percentOfClass == null || filing.previousPercent == null) return null;
  return Math.round((filing.percentOfClass - filing.previousPercent) * 100) / 100;
}

/**
 * One row per report, joined to the filer's 13F holder row (CIK first, then
 * name) for the quarter's action.
 */
export function buildBeneficialRows(
  filings: readonly BeneficialOwnerFiling[],
  holders: readonly JoinableHolder[] = [],
  fundMatches: ReadonlyMap<string, Pick<Holder13FMatch, "cik">> = new Map(),
): BeneficialOwnerRow[] {
  return filings.map((filing) => ({
    id: `${filing.accessionNumber}:${filing.filerCik ?? filing.filerName}`,
    filing,
    formLabel: beneficialFormLabel(filing),
    changePoints: pointChange(filing),
    thirteenF: thirteenFAction(matchFilerToHolder(filing, holders, fundMatches)),
    stake: disclosedStake(filing),
  }));
}

function sortValue(row: BeneficialOwnerRow, columnId: BeneficialColumnId): string | number | null {
  switch (columnId) {
    case "filer": return row.filing.filerName;
    case "form": return row.formLabel;
    case "percentOfClass": return row.filing.percentOfClass;
    case "change": return row.changePoints;
    case "shares": return row.filing.shares;
    case "eventDate": return row.filing.eventDate;
    case "filingDate": return row.filing.filingDate;
    case "thirteenF": {
      const value = row.thirteenF?.value;
      // NEW leads a descending sort without leaving the finite range compareSortValues keeps.
      return value == null ? null : value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : value;
    }
  }
}

/** Filers over the threshold (or not saying) first, then stakes under 5%, then exits. */
function stakeGroup(row: BeneficialOwnerRow): number {
  return row.stake === "exited" ? 2 : row.stake === "below-threshold" ? 1 : 0;
}

/** Sorted by the column within each stake group, whatever the direction; ties newest filing first. */
export function sortBeneficialRows(rows: readonly BeneficialOwnerRow[], preference: BeneficialSortPreference): BeneficialOwnerRow[] {
  return [...rows].sort((left, right) => stakeGroup(left) - stakeGroup(right)
    || compareSortValues(sortValue(left, preference.columnId), sortValue(right, preference.columnId), preference.direction)
    || right.filing.filingDate.localeCompare(left.filing.filingDate)
    || left.filing.filerName.localeCompare(right.filing.filerName));
}

// Widths as the table draws them: never narrower than the header and its sort marker.
const FORM_WIDTH = 6;
/** `22.2%`, `4.9% <5%`, `0.0% EXIT`. */
const PERCENT_WIDTH = 9;
const CHANGE_WIDTH = 8;
const SHARES_WIDTH = 8;
const DATE_WIDTH = 10;
const THIRTEEN_F_WIDTH = 5;
const MIN_FILER_WIDTH = 14;
/** The longest filer names and a group count; a wider pane keeps the figures beside the names. */
const MAX_FILER_WIDTH = 56;
/** Below this the event date gives its room to the filer's name; the filing date stays. */
const EVENT_FILER_WIDTH = 20;

export function buildBeneficialColumns(width: number): BeneficialColumn[] {
  const fixed = FORM_WIDTH + PERCENT_WIDTH + CHANGE_WIDTH + SHARES_WIDTH + DATE_WIDTH + THIRTEEN_F_WIDTH;
  // Two cells of padding and one gap after every column.
  const roomWithEvent = width - 2 - 8 - fixed - DATE_WIDTH;
  const showEvent = roomWithEvent >= EVENT_FILER_WIDTH;
  const filerWidth = Math.min(MAX_FILER_WIDTH, Math.max(MIN_FILER_WIDTH, showEvent ? roomWithEvent : roomWithEvent + DATE_WIDTH + 1));
  return [
    { id: "filer", label: "FILER", width: filerWidth, align: "left" },
    { id: "form", label: "FORM", width: FORM_WIDTH, align: "left" },
    { id: "percentOfClass", label: "% CLASS", width: PERCENT_WIDTH, align: "right" },
    { id: "change", label: "CHG", width: CHANGE_WIDTH, align: "right" },
    { id: "shares", label: "SHARES", width: SHARES_WIDTH, align: "right" },
    ...(showEvent ? [{ id: "eventDate" as const, label: "EVENT", width: DATE_WIDTH, align: "right" as const }] : []),
    { id: "filingDate", label: "FILED", width: DATE_WIDTH, align: "right" },
    { id: "thirteenF", label: "13F", width: THIRTEEN_F_WIDTH, align: "right" },
  ];
}

/** Entity suffixes a narrow column drops before it cuts into the name itself. */
const LEGAL_SUFFIX = /(?:[,\s]+(?:L\.?L\.?C|L\.?L\.?P|L\.?P|INC|LTD|LIMITED|CORP|CORPORATION|CO|PLC|N\.?A|S\.?A|AG|GMBH)\.?)+$/i;

/**
 * The filer's name in `width` cells, with ` +N` for the other reporting
 * persons of a group. The entity suffix goes first, then the name is cut
 * behind an ellipsis; the count is never cut.
 */
export function formatFilerName(name: string, otherPersons: number, width: number): string {
  const suffix = otherPersons > 0 ? ` +${otherPersons}` : "";
  const room = Math.max(1, width - displayWidth(suffix));
  if (displayWidth(name) <= room) return `${name}${suffix}`;
  const short = name.replace(LEGAL_SUFFIX, "").trim() || name;
  return `${clipToDisplayWidth(short, room)}${suffix}`;
}

/** The marker after a stake that is not a 5% holding: under the threshold, or reported at zero. */
export function stakeMarker(stake: BeneficialOwnerStatus | null): string {
  return stake === "below-threshold" ? "<5%" : stake === "exited" ? "EXIT" : "";
}

/**
 * The reported percent of class, as filed: `4.9%` stays `4.9%`. With
 * `marker`, a stake under 5% reads `4.9% <5%` and a report of zero
 * `0.0% EXIT`. A missing figure is a dash, or the bare marker when the
 * route says which side of 5% the stake is on.
 */
export function formatPercentOfClass(
  row: Pick<BeneficialOwnerRow, "stake" | "filing">,
  { marker = false }: { marker?: boolean } = {},
): string {
  const value = row.filing.percentOfClass;
  const mark = marker ? stakeMarker(row.stake) : "";
  if (value == null) return mark || "-";
  return mark ? `${value.toFixed(1)}% ${mark}` : `${value.toFixed(1)}%`;
}

export function formatPointChange(value: number | null): string {
  if (value == null) return "";
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "0.0 pt";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)} pt`;
}

export function formatOwnerShares(value: number | null): string {
  return value == null ? "-" : formatCompact(value);
}

/**
 * A row as `holders --form` and `fn HDS --form` print it; the keys are the
 * JSON contract. Numbers a report did not give stay null, and `status` is
 * the disclosed stake, null when the report does not say.
 */
export function beneficialReportRow(row: BeneficialOwnerRow) {
  const { filing } = row;
  return {
    filer: filing.filerName,
    filerCik: filing.filerCik,
    form: row.formLabel,
    formType: filing.form,
    kind: filing.kind,
    amendment: filing.amendment,
    amendmentNo: filing.amendmentNo,
    percentOfClass: filing.percentOfClass,
    previousPercent: filing.previousPercent ?? null,
    changePoints: row.changePoints,
    shares: filing.shares,
    classTitle: filing.classTitle,
    cusip: filing.cusip,
    eventDate: filing.eventDate,
    filingDate: filing.filingDate,
    previousFilingDate: filing.previousFilingDate ?? null,
    thirteenF: row.thirteenF?.label ?? null,
    status: row.stake,
    parsedFrom: filing.source,
    accessionNumber: filing.accessionNumber,
    filingUrl: filing.filingUrl,
    reportingPersons: filing.reportingPersons,
  };
}

export type BeneficialReportRow = ReturnType<typeof beneficialReportRow>;
