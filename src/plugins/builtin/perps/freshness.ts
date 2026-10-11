import type { PerpBoardRow } from "../../../api-client/perps";
import type { HeadlessPaneFreshness } from "../../../types/headless";
import { venueName, venuesOf } from "./model";

type Dated = Pick<PerpBoardRow, "venue" | "observedAt">;
type Funded = Pick<PerpBoardRow, "venue" | "fundingRate" | "fundingRate8h" | "fundingKind" | "nextFundingAt">;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const KINDS: Array<[PerpBoardRow["fundingKind"], string]> = [["current", "current estimate"], ["last-paid", "last paid"], ["continuous", "accrues continuously"]];

/** `08:00` on the UTC day of `now`, else with its weekday: `Mon 00:00`. */
function payTime(at: number, now: number): string {
  const iso = new Date(at).toISOString();
  return iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? iso.slice(11, 16) : `${WEEKDAYS[new Date(at).getUTCDay()]} ${iso.slice(11, 16)}`;
}

/**
 * When current estimates pay: the next funding time when every contract shown pays then, else each time with the
 * venues that report it (`08:00 UTC (Binance, Bybit)`). A venue that reports no next time is not given one.
 */
function paysText(rows: readonly Funded[], now: number): string | null {
  const venuesAt = new Map<number, Funded[]>();
  let unknown = false;
  for (const row of rows) {
    const at = row.nextFundingAt ? Date.parse(row.nextFundingAt) : Number.NaN;
    if (!Number.isFinite(at) || at < now) unknown = true;
    else venuesAt.set(at, [...venuesAt.get(at) ?? [], row]);
  }
  const times = [...venuesAt].sort(([a], [b]) => a - b);
  if (!times.length) return null;
  if (times.length === 1 && !unknown) return `${payTime(times[0]![0], now)} UTC`;
  return times.map(([at, group]) => `${payTime(at, now)} UTC (${venuesOf(group).map(venueName).join(", ")})`).join(", ");
}

/**
 * What a view's funding figures are, so a reader does not take a venue's current estimate for a settled rate:
 * `funding = current estimate, pays 08:00 UTC`. With several bases each names its venues. Null when no row shows funding.
 */
export function fundingNote(rows: readonly Funded[], now = Date.now()): string | null {
  const funded = rows.filter((row) => row.fundingRate != null || row.fundingRate8h != null);
  const kinds = KINDS.filter(([kind]) => funded.some((row) => row.fundingKind === kind));
  if (!kinds.length) return null;
  return `funding = ${kinds.map(([kind, text]) => {
    const group = funded.filter((row) => row.fundingKind === kind);
    const pays = kind === "current" ? paysText(group, now) : null;
    return `${text}${kinds.length > 1 ? ` (${venuesOf(group).map(venueName).join(", ")})` : ""}${pays ? `, pays ${pays}` : ""}`;
  }).join("; ")}`;
}

/**
 * How current a view of perpetual markets is: each venue's own newest observation, polled rather than streamed and
 * stale after an hour without a poll, and what the funding figures it shows (`funding`) are. The report, the capture
 * and the pane footer all read this, so they end with the same line.
 */
export function perpFreshness(rows: readonly Dated[], { funding = [], venue = "all", now = Date.now() }: {
  funding?: readonly Funded[]; venue?: string; now?: number;
} = {}): HeadlessPaneFreshness {
  const sources = venuesOf(rows).map((id) => ({ source: venueName(id), asOf: new Date(Math.max(...rows.filter((row) => row.venue === id)
    .map((row) => Date.parse(row.observedAt)))).toISOString() }));
  const source = sources.length ? sources.map((entry) => entry.source).join(", ") : venue !== "all" ? venueName(venue) : null;
  const note = fundingNote(funding, now);
  return { ...(source ? { source } : {}), sources, status: "delayed", maxAgeMinutes: 60, ...(note ? { note } : {}) };
}

/** What a capture reads of a row: when it was observed and whether the venue has stopped answering for it. */
export const perpObservation = (row: Pick<PerpBoardRow, "observedAt" | "stale">) => ({ observedAt: row.observedAt, stale: row.stale });
