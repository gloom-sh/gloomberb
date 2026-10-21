import type { CentralBankRatesPayload, CentralBankRow } from "../../../api-client/central-bank-rates";
import type { MarketBoardRow } from "../../../components/market-board";

// Two decimals like published policy rates, a third only for eighths such as a 3.875% midpoint.
const percentText = (value: number) => Math.abs(Number(value.toFixed(2)) - value) < 1e-9 ? value.toFixed(2) : `${Number(value.toFixed(3))}`;
export const policyRate = (value: number | null) => value == null ? "--" : `${percentText(value)}%`;
export const policyLevel = (row: CentralBankRow) => row.range ? `${percentText(row.range.lower)}-${percentText(row.range.upper)}%` : policyRate(row.value);
export const policyChange = (row: CentralBankRow) => row.changeBps == null ? "--"
  : `${row.changeBps > 0 ? "+" : ""}${Number(row.changeBps.toFixed(1))}bp ${row.direction === "hike" ? "↑" : row.direction === "cut" ? "↓" : ""}`.trim();
/** Members with no policy rate to publish, kept out of the board and the notices; docs/research-data.md explains them. */
export const hasNoPolicyRate = (row: CentralBankRow) => row.status === "unavailable"
  && (row.unavailableReason === "no-policy-rate" || row.unavailableReason === "no-unified-rate");
export function policyNotices(data: CentralBankRatesPayload): string[] {
  return data.rows.filter((row) => !hasNoPolicyRate(row)).flatMap((row) => row.status === "stale" ? [`${row.label}: stale, latest observation ${row.asOf ?? "unknown"}${row.lagDays == null ? "" : ` (${row.lagDays} days old)`}.`]
    : row.status === "unavailable" ? [`${row.label}: ${(row.unavailableReason ?? "unavailable").replaceAll("-", " ")}.`] : []);
}
export function policyHistory(row: CentralBankRow) {
  return row.history.filter((point) => (!row.percentile.windowStart || point.date >= row.percentile.windowStart)
    && (!row.percentile.windowEnd || point.date <= row.percentile.windowEnd));
}
export interface PolicyBoardRow extends MarketBoardRow { observation: CentralBankRow }
export function policyBoardRow(row: CentralBankRow): PolicyBoardRow {
  return { id: row.id, label: row.label, labelDetail: row.instrument, value: row.value, valueText: policyLevel(row),
    change: row.changeBps, changeText: policyChange(row), changeAsOf: row.lastChangeDate,
    percentile: row.percentile.value, asOf: row.asOf, status: row.status, observation: row,
    history: policyHistory(row).flatMap((point) => point.value == null ? [] : [{ date: new Date(point.date), close: point.value }]) };
}

const SOURCE_LABELS = { bis: "BIS", fred: "FRED" } as const;

/** Where the row's series is read from: `BIS` or `FRED`. */
const policySource = (row: CentralBankRow) => row.source ? SOURCE_LABELS[row.source] : null;

/** Each series' own page: one per FRED series (both bounds of the US range), the country's for BIS. */
function policySeriesUrls(row: CentralBankRow): string[] {
  if (row.source === "fred") return row.sourceSeriesIds.map((id) => `https://fred.stlouisfed.org/series/${id}`);
  return row.sourceUrl ? [row.sourceUrl] : [];
}

/** `BIS series D.GB (url)`; a two-series range cites each bound: `FRED series DFEDTARL (lower bound, url) and DFEDTARU (upper bound, url)`. */
function seriesCitation(row: CentralBankRow): string | null {
  const source = policySource(row);
  const ids = row.sourceSeriesIds;
  const urls = policySeriesUrls(row);
  if (!source || ids.length === 0) return null;
  if (ids.length === 2 && urls.length === 2) return `${source} series ${ids[0]} (lower bound, ${urls[0]}) and ${ids[1]} (upper bound, ${urls[1]})`;
  return `${source} series ${ids.join(" and ")}${urls.length ? ` (${urls.join(", ")})` : ""}`;
}

/**
 * One line to cite the row by: its instrument and rate, the series it is read
 * from with its page, and its own observation date, then the bank's site when
 * that confirmed the level. `Bank Rate 3.75%, BIS series D.GB (https://...), as of 2026-10-05`.
 */
export function policyCitation(row: CentralBankRow): string {
  const series = seriesCitation(row);
  if (row.value == null) {
    const missing = hasNoPolicyRate(row) ? `${row.label}: ${row.instrument.toLowerCase()}`
      : `${row.instrument}: no current observation (${(row.unavailableReason ?? "unavailable").replaceAll("-", " ")})`;
    return series ? `${missing}, ${series}` : missing;
  }
  const confirmed = row.confirmedAt && row.confirmationSourceUrl ? `; confirmed at ${row.confirmationSourceUrl} on ${row.confirmedAt.slice(0, 10)}` : "";
  return `${row.instrument} ${policyLevel(row)}${series ? `, ${series}` : ""}, as of ${row.asOf}${confirmed}`;
}

interface PolicyNextMeeting {
  /** The date, or why there is none: `not published`, `not verified`, `no policy rate`. */
  text: string;
  kind: "decision" | "fixing" | null;
  sourceUrl: string | null;
  verifiedAt: string | null;
}

/**
 * The next decision from the bank's own calendar, or China's LPR fixing. A
 * server that does not say why a meeting is missing predates the calendars,
 * so its null reads as not published.
 */
function policyNextMeeting(row: CentralBankRow): PolicyNextMeeting {
  const meeting = row.nextMeeting;
  if (meeting) return { text: meeting.date, kind: meeting.kind ?? "decision", sourceUrl: meeting.sourceUrl, verifiedAt: meeting.verifiedAt };
  const text = hasNoPolicyRate(row) || row.nextMeetingStatus === "no-policy-rate" ? "no policy rate"
    : row.nextMeetingStatus === "not-verified" ? "not verified" : "not published";
  return { text, kind: null, sourceUrl: null, verifiedAt: null };
}

/**
 * `next decision 2026-11-05, calendar verified 2026-10-12 at https://...`,
 * `next LPR fixing ...`, or `next decision not published`. The link comes
 * last and bare, so a narrow terminal wraps it onto a line of its own, whole.
 */
export function policyNextMeetingText(row: CentralBankRow): string {
  const meeting = policyNextMeeting(row);
  if (meeting.text === "no policy rate") return meeting.text;
  const event = meeting.kind === "fixing" ? "LPR fixing" : "decision";
  return meeting.sourceUrl ? `next ${event} ${meeting.text}, calendar verified ${meeting.verifiedAt} at ${meeting.sourceUrl}` : `next ${event} ${meeting.text}`;
}

/**
 * `last decision 2026-09-18 · ` (or `last LPR fixing`) before the next
 * meeting on a row's detail line; nothing when the server gives no date.
 */
export function policyLastDecisionText(row: CentralBankRow): string {
  const decision = row.lastDecision;
  if (!decision) return "";
  return `last ${decision.kind === "fixing" ? "LPR fixing" : "decision"} ${decision.date} · `;
}

/**
 * What an export says about one row, history aside: the board's figures, a
 * target range's bounds as numbers (`rangeLower`, `rangeUpper`; the rate is
 * its midpoint) and a citation block, `central_bank` to `citation`, named as
 * CSV heads them. `last_decision` is the bank's latest kept decision on or
 * before the observed change. Notes keep the caveats on the latest rate; the
 * BIS series definition goes with the history (`--history`).
 */
export function policyExportRow(row: CentralBankRow) {
  const board = policyBoardRow({ ...row, history: [] });
  const meeting = policyNextMeeting(row);
  return {
    id: row.id, label: row.label, instrument: row.instrument, central_bank: row.centralBank,
    value: row.value, unit: row.unit, range: row.range, rangeLower: row.range?.lower ?? null, rangeUpper: row.range?.upper ?? null,
    valueText: board.valueText, changeBps: row.changeBps, changeText: board.changeText, lastChangeDate: row.lastChangeDate,
    previousValue: row.previousValue, percentileValue: row.percentile.value,
    asOf: row.asOf, lagDays: row.lagDays, status: row.status, unavailableReason: row.unavailableReason,
    source: policySource(row), series_id: row.sourceSeriesIds.join(", ") || null, source_url: policySeriesUrls(row).join(" ") || null,
    as_of: row.asOf, last_decision: row.lastDecision?.date ?? null, next_meeting: meeting.text, next_meeting_kind: meeting.kind,
    next_meeting_source_url: meeting.sourceUrl, next_meeting_verified_at: meeting.verifiedAt,
    citation: policyCitation(row), notes: row.notes.filter((note) => !row.seriesNotes?.includes(note)),
  };
}

/**
 * Why a member with no policy rate is left off the board and its exports:
 * `Argentina is not listed: no adopted policy rate (BIS series D.AR, https://...).`
 */
export function policyUnlistedNote(row: CentralBankRow): string {
  const source = policySource(row);
  const urls = policySeriesUrls(row);
  const series = source && row.sourceSeriesIds.length > 0 ? `${source} series ${row.sourceSeriesIds.join(" and ")}${urls.length ? `, ${urls.join(" ")}` : ""}` : null;
  return `${row.label} is not listed: ${row.instrument.toLowerCase()}${series ? ` (${series})` : ""}.`;
}

/** Who a chart of the row's series cites: `FRED series ECBDFR`, published by the European Central Bank. */
export function policySeriesAttribution(row: CentralBankRow): { source: string; publisher?: string } | null {
  const source = policySource(row);
  if (!source || row.sourceSeriesIds.length === 0) return null;
  return { source: `${source} series ${row.sourceSeriesIds.join(" and ")}`, ...(row.centralBank ? { publisher: row.centralBank } : {}) };
}
