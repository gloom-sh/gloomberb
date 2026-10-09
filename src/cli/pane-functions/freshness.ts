import type {
  HeadlessBundleResult,
  HeadlessFreshnessStatus,
  HeadlessPaneDefinition,
  HeadlessPaneFreshness,
  HeadlessPaneResult,
  HeadlessPaneRow,
  HeadlessSeriesResult,
  HeadlessSnapshotResult,
} from "../../types/plugin";
import { formatUtcTime, parseReportTime, type ReportTime } from "../../utils/utc-time";
import { isRecord } from "../../utils/guards";
import { latestRegularSessionClose } from "../../market-data/market/freshness";

/**
 * The four states of docs/usage.md#how-current-a-report-is, plus `unreported`
 * for a report that cannot tell: a rendered view whose footer names no state,
 * or a plugin that declares nothing and carries no feed signal.
 */
type ReportFreshnessStatus = HeadlessFreshnessStatus | "unreported";

/** What every `fn` report cites about its data, in its JSON and its last text line. */
export interface ReportFreshness {
  source: string;
  /** Newest observation: an ISO instant in UTC, or an ISO date. Null when nothing in the data is dated. */
  asOf: string | null;
  /** Oldest observation, when it is more than a day older than `asOf`. */
  oldest?: string;
  status: ReportFreshnessStatus;
  delayMinutes?: number;
  /** How old the stale data is: the newest observation, or the oldest stale row when only some are. */
  ageMinutes?: number;
  /** When only some rows are stale: how many, of the rows that say whether they are... */
  staleCount?: number;
  observationCount?: number;
  /** ...and what the rest are. */
  feed?: "live" | "delayed";
  basis?: string;
  /** When this report was built. */
  retrievedAt: string;
}

const DEFAULT_REPORT_SOURCE = "Gloom Cloud";

/** Top-level row and metadata keys that say when a value was observed. */
const OBSERVATION_KEYS = [
  "asOf", "asOfDate", "observedAt", "lastUpdated", "updatedAt", "quoteTime",
  "quoteAsOf", "priceAsOf", "sourceAsOf", "lastTradeTime",
];
// A stamp a little ahead of this clock is skew; further ahead it is a schedule, not an observation.
const FUTURE_TOLERANCE_MS = 10 * 60_000;
const OLDEST_GAP_MS = 24 * 60 * 60_000;
// A scheduled release can slip by hours; a day past it, the data has missed it.
const RELEASE_GRACE_MS = 24 * 60 * 60_000;

interface FeedSignals {
  live: boolean;
  delayed: boolean;
  delayMinutes?: number;
  /** A record-wide stale flag (metadata), read only when no row says whether it is stale. */
  stale: boolean;
  /** Rows and series that carry a `stale` flag, and the times of those that are stale. */
  flagged: number;
  staleTimes: Array<ReportTime | null>;
}

interface Observations {
  /** One time per row, item or series: what `oldest` compares. */
  units: ReportTime[];
  /** Metadata and snapshot stamps: candidates for `asOf` only. */
  extra: ReportTime[];
}

function emptySignals(): FeedSignals {
  return { live: false, delayed: false, stale: false, flagged: 0, staleTimes: [] };
}

function readFeedSignals(record: Record<string, unknown>, signals: FeedSignals): void {
  if (record.dataSource === "live") signals.live = true;
  if (record.dataSource === "delayed") signals.delayed = true;
  const delay = record.delayMinutes;
  if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) {
    signals.delayed = true;
    signals.delayMinutes = Math.max(signals.delayMinutes ?? 0, delay);
  }
}

/** A row's or series' own stale flag; worst of across them, counted so a partly stale board says how much. */
function readUnitStale(record: Record<string, unknown>, time: ReportTime | null, signals: FeedSignals): void {
  if (typeof record.stale !== "boolean") return;
  signals.flagged += 1;
  if (record.stale) signals.staleTimes.push(time);
}

function observedTime(record: Record<string, unknown>, now: number, keys: readonly string[] = OBSERVATION_KEYS): ReportTime | null {
  let newest: ReportTime | null = null;
  for (const key of keys) {
    const time = parseReportTime(record[key]);
    if (time && time.time <= now + FUTURE_TOLERANCE_MS && (!newest || time.time > newest.time)) newest = time;
  }
  return newest;
}

function resultRecords(definition: Pick<HeadlessPaneDefinition, "shape">, result: HeadlessPaneResult): HeadlessPaneRow[] {
  switch (definition.shape) {
    case "rows":
      return (result as { rows: HeadlessPaneRow[] }).rows;
    case "bundle":
      return (result as HeadlessBundleResult).sections.flatMap((section) => (
        "rows" in section && section.rows ? section.rows : []
      ));
    case "snapshot":
      return (result as HeadlessSnapshotResult).items;
    case "series":
      return [];
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
}

function seriesNewestTime(series: HeadlessSeriesResult["series"][number], now: number): ReportTime | null {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const point = series.points[index]!;
    if (point.value == null && point.close == null) continue;
    const time = parseReportTime(point.date);
    if (time && time.time <= now + FUTURE_TOLERANCE_MS) return time;
  }
  return null;
}

function collect(
  definition: Pick<HeadlessPaneDefinition, "shape">,
  result: HeadlessPaneResult,
  now: number,
  { observedKey, ignoreStaleFlags }: Pick<HeadlessPaneFreshness, "observedKey" | "ignoreStaleFlags">,
): { signals: FeedSignals; observations: Observations } {
  const signals = emptySignals();
  const observations: Observations = { units: [], extra: [] };
  const rowKeys = observedKey ? [observedKey] : OBSERVATION_KEYS;
  for (const row of resultRecords(definition, result)) {
    if (!isRecord(row)) continue;
    readFeedSignals(row, signals);
    const time = observedTime(row, now, rowKeys);
    if (!ignoreStaleFlags) readUnitStale(row, time, signals);
    if (time) observations.units.push(time);
  }
  if (definition.shape === "series") {
    for (const series of (result as HeadlessSeriesResult).series) {
      const record = series as unknown as Record<string, unknown>;
      readFeedSignals(record, signals);
      const time = seriesNewestTime(series, now);
      if (!ignoreStaleFlags) readUnitStale(record, time, signals);
      if (time) observations.units.push(time);
    }
  }
  if (isRecord(result.metadata)) {
    readFeedSignals(result.metadata, signals);
    if (result.metadata.stale === true && !ignoreStaleFlags) signals.stale = true;
    const time = observedKey ? null : observedTime(result.metadata, now);
    if (time) observations.extra.push(time);
  }
  if (definition.shape === "snapshot" && !observedKey) {
    const time = parseReportTime((result as HeadlessSnapshotResult).asOf);
    if (time && time.time <= now + FUTURE_TOLERANCE_MS) observations.extra.push(time);
  }
  return { signals, observations };
}

function isoTime(time: ReportTime): string {
  return time.dateOnly ? new Date(time.time).toISOString().slice(0, 10) : new Date(time.time).toISOString();
}

function newest(times: ReportTime[]): ReportTime | null {
  return times.reduce<ReportTime | null>((best, time) => (!best || time.time > best.time ? time : best), null);
}

function oldest(times: ReportTime[]): ReportTime | null {
  return times.reduce<ReportTime | null>((best, time) => (!best || time.time < best.time ? time : best), null);
}

/** The declaration with the result's own fields winning over the definition's. */
function mergeDeclarations(...declarations: Array<HeadlessPaneFreshness | undefined>): HeadlessPaneFreshness {
  const merged: HeadlessPaneFreshness = {};
  for (const declaration of declarations) {
    if (!declaration) continue;
    for (const [key, value] of Object.entries(declaration)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

const FEED_RANK: Record<"live" | "delayed" | "stale", number> = { live: 0, delayed: 1, stale: 2 };

function worstFeedStatus(statuses: Array<"live" | "delayed" | "stale">): "live" | "delayed" | "stale" | null {
  return statuses.reduce<"live" | "delayed" | "stale" | null>((worst, status) => (
    !worst || FEED_RANK[status] > FEED_RANK[worst] ? status : worst
  ), null);
}

/** Completed US sessions after the day of `newest`, counted back from `now`, up to `limit`. */
function sessionsAfter(newest: ReportTime, now: number, limit: number): number {
  const newestDate = new Date(newest.time).toISOString().slice(0, 10);
  let count = 0;
  let cursor = now;
  while (count < limit) {
    const close = latestRegularSessionClose("NYSE", cursor);
    if (!close || close.date <= newestDate) break;
    count += 1;
    cursor = close.close - 1;
  }
  return count;
}

/** What the data's declared schedule says about its age, whatever kind of data it is. */
function overdue(declared: HeadlessPaneFreshness, asOf: ReportTime | null, now: number): boolean {
  const nextExpected = declared.nextExpectedAt != null ? parseReportTime(declared.nextExpectedAt) : null;
  if (nextExpected != null && now > nextExpected.time + RELEASE_GRACE_MS) return true;
  if (!asOf) return false;
  if (declared.maxAgeMinutes != null && now - asOf.time > declared.maxAgeMinutes * 60_000) return true;
  return declared.cadence === "daily" && sessionsAfter(asOf, now, 2) > 1;
}

interface FreshnessInputs {
  declared: HeadlessPaneFreshness;
  signals: FeedSignals;
  observations: Observations;
  now: number;
}

function resolveFreshness({ declared, signals, observations, now }: FreshnessInputs): ReportFreshness {
  const declaredAsOf = declared.asOf != null ? parseReportTime(declared.asOf) : null;
  const asOf = declaredAsOf ?? newest([...observations.units, ...observations.extra]);
  // A loader that dates its data itself also says how old the oldest part is, or nothing;
  // `oldest: null` says the rows are a history, whose first entry is not stale data.
  const oldestTime = declared.oldest != null ? parseReportTime(declared.oldest)
    : declaredAsOf || declared.oldest === null ? null : oldest(observations.units);
  const late = overdue(declared, asOf, now);

  let status: ReportFreshnessStatus;
  let delayMinutes: number | undefined;
  let staleAt: ReportTime | null = null;
  let partial: { staleCount: number; observationCount: number; feed?: "live" | "delayed" } | null = null;
  if (declared.status === "not-a-feed") {
    // Old filed or published data is not stale; only a schedule it missed makes it so,
    // or rows that check their own schedule and say they are stale.
    const staleRows = signals.staleTimes.length;
    if (late || (staleRows > 0 && staleRows === signals.flagged)) {
      status = "stale";
      staleAt = asOf;
    } else if (staleRows > 0) {
      status = "stale";
      partial = { staleCount: staleRows, observationCount: signals.flagged };
      staleAt = oldest(signals.staleTimes.filter((time): time is ReportTime => time != null));
    } else {
      status = "not-a-feed";
    }
  } else {
    const feed = worstFeedStatus([
      ...(declared.status ? [declared.status] : []),
      ...(signals.live ? ["live" as const] : []),
      ...(signals.delayed ? ["delayed" as const] : []),
    ]);
    const staleRows = signals.staleTimes.length;
    // Rows that say whether they are stale outrank a summary flag beside them.
    const allStale = feed === "stale" || late
      || (signals.flagged > 0 ? staleRows === signals.flagged : signals.stale);
    if (allStale) {
      status = "stale";
      staleAt = asOf;
    } else if (staleRows > 0) {
      status = "stale";
      partial = {
        staleCount: staleRows,
        observationCount: signals.flagged,
        ...(feed === "live" || feed === "delayed" ? { feed } : {}),
      };
      staleAt = oldest(signals.staleTimes.filter((time): time is ReportTime => time != null));
    } else {
      status = feed ?? "unreported";
    }
    // A partly stale board still says how far its fresh rows are held back.
    if (status === "delayed" || partial?.feed === "delayed") delayMinutes = declared.delayMinutes ?? signals.delayMinutes;
  }

  return {
    source: declared.source?.trim() || DEFAULT_REPORT_SOURCE,
    asOf: asOf ? isoTime(asOf) : null,
    ...(asOf && oldestTime && asOf.time - oldestTime.time > OLDEST_GAP_MS ? { oldest: isoTime(oldestTime) } : {}),
    status,
    ...(delayMinutes != null && delayMinutes > 0 ? { delayMinutes } : {}),
    ...(status === "stale" && staleAt ? { ageMinutes: Math.max(0, Math.floor((now - staleAt.time) / 60_000)) } : {}),
    ...(partial ?? {}),
    ...(status === "not-a-feed" && declared.basis ? { basis: declared.basis } : {}),
    retrievedAt: new Date(now).toISOString(),
  };
}

/**
 * Source, as-of and status for a headless report: what the loader declared
 * (the result's `freshness` over the definition's), the rest read from the
 * standard signals in the result. Never live unless the data says so.
 */
export function deriveHeadlessFreshness(
  definition: Pick<HeadlessPaneDefinition, "shape" | "freshness">,
  result: HeadlessPaneResult,
  now = Date.now(),
): ReportFreshness {
  const declared = mergeDeclarations(definition.freshness, result.freshness);
  const { signals, observations } = collect(definition, result, now, declared);
  return resolveFreshness({ declared, signals, observations, now });
}

/**
 * A rendered view has no structured data: the source is the pane's
 * declaration, the times are the cells that carry an instant, and the state
 * is what the pane's own footer says, or not reported.
 */
export function deriveRenderedFreshness(
  declared: HeadlessPaneFreshness | undefined,
  input: { footerText: string; cellTimes: unknown[] },
  now = Date.now(),
): ReportFreshness {
  const signals = emptySignals();
  const footer = input.footerText;
  const delayed = /\b(\d+)\s*(?:m|min|minutes?)\s+delayed\b/i.exec(footer);
  if (delayed) {
    signals.delayed = true;
    signals.delayMinutes = Number(delayed[1]);
  } else if (/\bdelayed\b/i.test(footer)) {
    signals.delayed = true;
  }
  if (/\bstale\b/i.test(footer)) signals.stale = true;
  if (/\breal-time\b/i.test(footer)) signals.live = true;
  const units = input.cellTimes
    .map((value) => parseReportTime(value))
    .filter((time): time is ReportTime => time != null && time.time <= now + FUTURE_TOLERANCE_MS);
  return resolveFreshness({
    declared: mergeDeclarations(declared),
    signals,
    // Rendered rows are often a history (a news list, a filing feed), so only the newest is cited.
    observations: { units: [], extra: units },
    now,
  });
}

function ageText(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

function delayedText(minutes: number | undefined): string {
  return minutes ? `Delayed ${minutes} min` : "Delayed";
}

function statusText(freshness: ReportFreshness): string {
  switch (freshness.status) {
    case "live":
      return "Live";
    case "delayed":
      return delayedText(freshness.delayMinutes);
    case "stale": {
      if (freshness.staleCount != null && freshness.observationCount != null) {
        const rest = freshness.feed === "live" ? "Live" : freshness.feed === "delayed" ? delayedText(freshness.delayMinutes) : null;
        return `${rest ? `${rest}, ` : ""}${freshness.staleCount} of ${freshness.observationCount} stale`;
      }
      return freshness.ageMinutes != null ? `Stale (${ageText(freshness.ageMinutes)} old)` : "Stale";
    }
    case "not-a-feed":
      return freshness.basis ? `Not a live feed (${freshness.basis})` : "Not a live feed";
    case "unreported":
      return "Status not reported";
    default: {
      const _exhaustive: never = freshness.status;
      return _exhaustive;
    }
  }
}

/**
 * The one line every `fn` text report ends with:
 * `Source: Gloom Cloud | As of 2026-10-09 00:08 UTC | Delayed 10 min`.
 * Without a dated observation it says when the report was retrieved instead.
 */
export function formatFreshnessLine(freshness: ReportFreshness): string {
  const time = freshness.asOf
    ? `As of ${formatUtcTime(freshness.asOf)}${freshness.oldest ? ` (oldest ${freshness.oldest.slice(0, 10)})` : ""}`
    : `Retrieved ${formatUtcTime(freshness.retrievedAt)}`;
  return [`Source: ${freshness.source}`, time, statusText(freshness)].join(" | ");
}
