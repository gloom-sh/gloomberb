import { ProviderMissError } from "./provider-errors";

const COVERAGE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date (YYYY-MM-DD) that can bound a price history. */
export function isHistoryCoverageDate(value: unknown): value is string {
  return typeof value === "string" && COVERAGE_DATE.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * The first date a source vouches for, whatever its reason (an unverified
 * predecessor lineage, a fund's inception). No symbol is checked: any declared
 * boundary applies to the history it came with. The later boundary wins.
 */
export function parseHistoryCoverageStart(coverage: unknown): string | undefined {
  if (!coverage || typeof coverage !== "object") return undefined;
  const { verifiedLineageStart, firstAllowedBarDate } = coverage as Record<string, unknown>;
  const dates = [verifiedLineageStart, firstAllowedBarDate].filter(isHistoryCoverageDate);
  return dates.length ? dates.reduce((latest, date) => date > latest ? date : latest) : undefined;
}

/**
 * Why a source serves nothing before its coverage, when it says, such as
 * "old-shekel quotes before 1992 are not served": one line of plain text.
 */
export function parseHistoryCoverageNote(coverage: unknown): string | undefined {
  if (!coverage || typeof coverage !== "object" || !parseHistoryCoverageStart(coverage)) return undefined;
  return historyCoverageNoteText((coverage as Record<string, unknown>).note);
}

/** A coverage note fit to print: a short line without control characters, its closing full stop dropped. */
export function historyCoverageNoteText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const note = value.trim().replace(/\.$/, "");
  return note && note.length <= 200 && !/[\u0000-\u001f\u007f]/.test(note) ? note : undefined;
}

function historyCoverageMessage(coverageStart: string, note?: string): string {
  return note
    ? `Price history starts ${coverageStart}; ${note}.`
    : `Verified price history starts ${coverageStart}; earlier prices are excluded.`;
}

/** Shown while the visible window starts before the source's coverage. */
export function historyCoverageNotice(coverageStart: string | undefined, visibleStart: number | null, note?: string): string | null {
  if (!coverageStart || (visibleStart !== null && visibleStart >= Date.parse(coverageStart))) return null;
  return historyCoverageMessage(coverageStart, note);
}

/** The whole requested window lies before the source's declared coverage. */
export class HistoryCoverageError extends ProviderMissError {
  constructor(readonly coverageStart: string) {
    super(historyCoverageMessage(coverageStart));
    this.name = "HistoryCoverageError";
  }
}
