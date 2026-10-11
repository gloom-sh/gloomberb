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
import { localTimeSuffix, parseReportTime, type ReportTime } from "../../utils/utc-time";
import { isRecord } from "../../utils/guards";
import { latestRegularSessionClose } from "../../market-data/market/freshness";
import { reportMarketSession, type ReportMarket, type SessionObservation } from "./market-session";

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
  /** How far the data is held back; the most of its rows when they differ... */
  delayMinutes?: number;
  /** ...and the least, only when it is less. */
  minDelayMinutes?: number;
  /** How old the stale data is: the newest observation, or the oldest stale row when only some are. */
  ageMinutes?: number;
  /** When only some rows are stale: how many, of the rows that say whether they are... */
  staleCount?: number;
  observationCount?: number;
  /** ...and what the rest are. */
  feed?: "live" | "delayed";
  basis?: string;
  /** Set when the dates are the start of a period: the status line then reads `Sep 2026 (monthly)`. */
  periodicity?: "monthly" | "quarterly" | "annual";
  /** The local date of the session close `asOf` is, when the newest observation is its venue's latest close. */
  asOfClose?: string;
  /**
   * Whose trading day the dated as-of (`asOfClose`, or a date-only `asOf`) is,
   * when one market's calendar dates it: `US`, or a venue code such as `ASX`.
   */
  tradingDayMarket?: string;
  /** Where the venues of a quote report stand now, from their session calendars. */
  market?: ReportMarket;
  /**
   * For a dataset (declared `dataset`, with no quote among its rows): whole UTC
   * days from the last day its newest observation covers to when this report
   * was built. A capture's status line then reads `observed Sun 4 Oct · lag 6d`.
   */
  lagDays?: number;
  /**
   * Each source's own newest observation, in the order declared, when the data
   * comes from several sources polled apart: `asOf` is the newest of them.
   */
  sources?: ReportSourceAsOf[];
  /**
   * Whole minutes from the oldest of `sources` (or, declared `oldestAge`, the
   * oldest observation) to when this report was built: `oldest 9 min`.
   */
  oldestAgeMinutes?: number;
  /** What the figures are, said after the status: `funding = current estimate, pays 08:00 UTC`. */
  note?: string;
  /** When this report was built. */
  retrievedAt: string;
}

/** One source's newest observation: an ISO instant in UTC. */
interface ReportSourceAsOf {
  source: string;
  asOf: string;
}

const DEFAULT_REPORT_SOURCE = "Gloom Cloud";

/** Top-level row and metadata keys that say when a value was observed. */
const OBSERVATION_KEYS = [
  "asOf", "asOfDate", "observedAt", "quoteTime",
  "quoteAsOf", "priceAsOf", "sourceAsOf", "lastTradeTime", "timestamp",
];
// Updates can be refresh stamps; use them only when there is no explicit observation.
const UPDATE_KEYS = ["lastUpdated", "updatedAt"];
// A stamp a little ahead of this clock is skew; further ahead it is a schedule, not an observation.
const FUTURE_TOLERANCE_MS = 10 * 60_000;
const OLDEST_GAP_MS = 24 * 60 * 60_000;
// A scheduled release can slip by hours; a day past it, the data has missed it.
const RELEASE_GRACE_MS = 24 * 60 * 60_000;

interface FeedSignals {
  live: boolean;
  delayed: boolean;
  delayMinutes?: number;
  minDelayMinutes?: number;
  /** A record-wide stale flag (metadata), read only when no row says whether it is stale. */
  stale: boolean;
  /** Rows and series that carry a `stale` flag, and the times of those that are stale. */
  flagged: number;
  staleTimes: Array<ReportTime | null>;
  /** Rows that name the venue whose sessions they follow (`sessionExchange`), with their time. */
  sessions: SessionObservation[];
}

interface Observations {
  /** One time per row, item or series: what `oldest` compares. */
  units: ReportTime[];
  /** Metadata and snapshot stamps: candidates for `asOf` only. */
  extra: ReportTime[];
}

function emptySignals(): FeedSignals {
  return { live: false, delayed: false, stale: false, flagged: 0, staleTimes: [], sessions: [] };
}

function readFeedSignals(record: Record<string, unknown>, signals: FeedSignals): void {
  if (record.dataSource === "live") signals.live = true;
  if (record.dataSource === "delayed") signals.delayed = true;
  const delay = record.delayMinutes;
  if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) {
    signals.delayed = true;
    signals.delayMinutes = Math.max(signals.delayMinutes ?? 0, delay);
    signals.minDelayMinutes = Math.min(signals.minDelayMinutes ?? delay, delay);
  }
}

/** A quote row's venue and reported session, so the report can say whether its market is open. */
function readSession(record: Record<string, unknown>, time: ReportTime | null, signals: FeedSignals): void {
  const exchange = record.sessionExchange;
  if (typeof exchange !== "string" || !exchange.trim()) return;
  signals.sessions.push({
    exchange,
    ...(typeof record.marketState === "string" ? { marketState: record.marketState } : {}),
    time,
  });
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
    const time = observedTime(row, now, rowKeys)
      ?? (observedKey ? null : observedTime(row, now, UPDATE_KEYS));
    if (!ignoreStaleFlags) readUnitStale(row, time, signals);
    readSession(row, time, signals);
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
    // An explicit summary as-of can be a real observation (CRYP's newest quote).
    // A summary update stamp must not supersede dated rows.
    const time = observedKey ? null : observedTime(result.metadata, now)
      ?? (observations.units.length ? null : observedTime(result.metadata, now, UPDATE_KEYS));
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

/**
 * Completed sessions after the day of `newest`, counted back from `now`, up to
 * `limit`: the US's, or `exchange`'s when the app knows its sessions.
 */
function sessionsAfter(newest: ReportTime, now: number, limit: number, exchange?: string): number {
  const newestDate = new Date(newest.time).toISOString().slice(0, 10);
  const venue = exchange && latestRegularSessionClose(exchange, now) ? exchange : "NYSE";
  let count = 0;
  let cursor = now;
  while (count < limit) {
    const close = latestRegularSessionClose(venue, cursor);
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
  return declared.cadence === "daily" && sessionsAfter(asOf, now, 2, declared.cadenceExchange) > 1;
}

/**
 * Whole UTC days from the last day an observation covers to `now`: its own
 * day, or the last day of the month, quarter or year a periodic date starts.
 * September's figure read on 10 Oct lags 10 days, not 39.
 */
function datasetLagDays(observed: ReportTime, periodicity: ReportFreshness["periodicity"], now: number): number {
  const day = new Date(observed.time);
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();
  const through = !periodicity ? Date.UTC(year, month, day.getUTCDate())
    // Day 0 of the month after the period is its last day.
    : periodicity === "monthly" ? Date.UTC(year, month + 1, 0)
      : periodicity === "quarterly" ? Date.UTC(year, month - (month % 3) + 3, 0)
        : Date.UTC(year, 12, 0);
  const today = new Date(now);
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((todayStart - through) / DAY_MS));
}

interface FreshnessInputs {
  declared: HeadlessPaneFreshness;
  signals: FeedSignals;
  observations: Observations;
  now: number;
}

/** The declared sources that name themselves and carry a time, in the order declared. */
function declaredSources(declared: HeadlessPaneFreshness, now: number): Array<{ source: string; time: ReportTime }> {
  return (declared.sources ?? []).flatMap(({ source, asOf }) => {
    const name = source.trim();
    const time = observedTime({ asOf }, now, ["asOf"]);
    return name && time && !time.dateOnly ? [{ source: name, time }] : [];
  });
}

function resolveFreshness({ declared, signals, observations, now }: FreshnessInputs): ReportFreshness {
  const sources = declaredSources(declared, now);
  // Sources date the data by their own observations, as a declared as-of does.
  const declaredAsOf = observedTime({ asOf: declared.asOf }, now, ["asOf"]) ?? newest(sources.map(({ time }) => time));
  const asOf = declaredAsOf ?? newest([...observations.units, ...observations.extra]);
  // The oldest source, not the newest, says how far behind the view can be.
  const agedFrom = sources.length ? oldest(sources.map(({ time }) => time))
    : declared.oldestAge ? oldest(observations.units) ?? asOf : null;
  const oldestAgeMinutes = agedFrom && !agedFrom.dateOnly ? Math.max(0, Math.floor((now - agedFrom.time) / 60_000)) : null;
  // A loader that dates its data itself also says how old the oldest part is, or nothing;
  // `oldest: null` says the rows are a history, whose first entry is not stale data.
  const oldestTime = declared.oldest != null ? parseReportTime(declared.oldest)
    : declaredAsOf || declared.oldest === null ? null : oldest(observations.units);
  const late = overdue(declared, asOf, now);

  let status: ReportFreshnessStatus;
  let delayMinutes: number | undefined;
  let minDelayMinutes: number | undefined;
  let staleAt: ReportTime | null = null;
  let partial: { staleCount: number; observationCount: number; feed?: "live" | "delayed" } | null = null;
  if (declared.status === "not-a-feed") {
    // Age alone does not make filed or published data stale. Honor explicit flags,
    // with row-level flags outranking the metadata summary, or a missed schedule.
    const staleRows = signals.staleTimes.length;
    if (late || (signals.flagged > 0 ? staleRows === signals.flagged : signals.stale)) {
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
    if (status === "delayed" || partial?.feed === "delayed") {
      delayMinutes = declared.delayMinutes ?? signals.delayMinutes;
      if (declared.delayMinutes == null && signals.minDelayMinutes != null && delayMinutes != null && signals.minDelayMinutes < delayMinutes) {
        minDelayMinutes = signals.minDelayMinutes;
      }
    }
  }
  const { market, closeDate, closeMarket } = reportMarketSession(signals.sessions, now);
  // The close wording dates the newest observation, so only when that is what `asOf` is.
  const asOfClose = closeDate && asOf && !declaredAsOf ? closeDate : null;
  const tradingDayMarket = asOfClose ? closeMarket
    : asOf?.dateOnly ? declared.tradingDayMarket?.trim() || null : null;
  const periodicity = declared.periodicity && asOf?.dateOnly ? declared.periodicity : undefined;
  // Rows that are quotes (a feed, a venue's session) keep the market line, even on a dataset's pane.
  const quoted = signals.live || signals.delayed || signals.sessions.length > 0;
  const lagDays = declared.dataset && asOf && !quoted && (status === "not-a-feed" || status === "stale")
    ? datasetLagDays(asOf, periodicity, now) : null;

  const note = declared.note?.trim();
  return {
    source: declared.source?.trim() || (sources.length ? [...new Set(sources.map(({ source }) => source))].join(", ") : DEFAULT_REPORT_SOURCE),
    asOf: asOf ? isoTime(asOf) : null,
    ...(asOf && oldestTime && asOf.time - oldestTime.time > OLDEST_GAP_MS ? { oldest: isoTime(oldestTime) } : {}),
    status,
    ...(delayMinutes != null && delayMinutes > 0 ? { delayMinutes } : {}),
    ...(minDelayMinutes != null && minDelayMinutes > 0 ? { minDelayMinutes } : {}),
    ...(status === "stale" && staleAt ? { ageMinutes: Math.max(0, Math.floor((now - staleAt.time) / 60_000)) } : {}),
    ...(partial ?? {}),
    ...(status === "not-a-feed" && declared.basis ? { basis: declared.basis } : {}),
    ...(periodicity ? { periodicity } : {}),
    ...(asOfClose ? { asOfClose } : {}),
    ...(tradingDayMarket ? { tradingDayMarket } : {}),
    ...(market ? { market } : {}),
    ...(lagDays != null ? { lagDays } : {}),
    ...(sources.length ? { sources: sources.map(({ source, time }) => ({ source, asOf: isoTime(time) })) } : {}),
    ...(oldestAgeMinutes != null ? { oldestAgeMinutes } : {}),
    ...(note ? { note } : {}),
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
 * is what the pane's own footer says, or not reported. A pane that dates its
 * figures itself publishes `observed` records, read as a headless report's
 * rows are: quote or rate times, feed, delay, stale flags and venue sessions.
 */
export function deriveRenderedFreshness(
  declared: HeadlessPaneFreshness | undefined,
  input: { footerText: string; cellTimes: unknown[]; observed?: readonly Record<string, unknown>[] },
  now = Date.now(),
): ReportFreshness {
  const merged = mergeDeclarations(declared);
  const observed = input.observed?.length
    ? collect({ shape: "rows" }, { rows: input.observed as HeadlessPaneRow[] }, now, merged)
    : null;
  const signals = observed?.signals ?? emptySignals();
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
    declared: merged,
    signals,
    // Rendered rows are often a history (a news list, a filing feed), so only the newest is cited.
    observations: { units: observed?.observations.units ?? [], extra: [...(observed?.observations.extra ?? []), ...units] },
    now,
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = 24 * 60 * 60_000;
/** A reopen further ahead than this reads with its date, not just its weekday. */
const WEEKDAY_ONLY_MS = 6 * DAY_MS;

/**
 * `Fri 9 Oct 2026` for a `YYYY-MM-DD` date. Always with its year: a report
 * read later, or pasted somewhere, still says which day it means.
 */
function dayText(date: string): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) return date;
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/**
 * `US trading day Fri 9 Oct 2026`: a date names whose day it is when one
 * market's calendar dates it, so a reader a day ahead of New York does not take
 * the US Friday for their own. Never shifted to the reader's zone.
 */
function tradingDayText(date: string, market: string | undefined): string {
  return market ? `${market} trading day ${dayText(date)}` : dayText(date);
}

/** `Sep 2026`, `Q2 2026` or `2026` for the period a date starts. */
function periodText(date: string, periodicity: NonNullable<ReportFreshness["periodicity"]>): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) return date;
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();
  return periodicity === "monthly" ? `${MONTHS[month]} ${year}`
    : periodicity === "quarterly" ? `Q${Math.floor(month / 3) + 1} ${year}`
      : `${year}`;
}

/** The period a FRED series frequency ("Monthly", "Quarterly") publishes in; null for daily and weekly series, whose dates are days. */
export function periodicityOf(frequency: string | null | undefined): ReportFreshness["periodicity"] | null {
  const word = frequency?.trim().toLowerCase() ?? "";
  return word.startsWith("monthly") ? "monthly" : word.startsWith("quarterly") ? "quarterly" : word.startsWith("annual") ? "annual" : null;
}

/**
 * `Fri 9 Oct 2026 23:59 UTC`, or `Fri 9 Oct 2026` for a date. With `local`, the
 * reader's own time follows when they set a zone: `(Sat 10 Oct 08:59 Asia/Tokyo)`.
 */
function timeText(value: string, local: boolean): string {
  const time = parseReportTime(value);
  if (!time) return value;
  const iso = new Date(time.time).toISOString();
  if (time.dateOnly) return dayText(iso);
  return `${dayText(iso)} ${iso.slice(11, 16)} UTC${local ? localTimeSuffix(time.time) : ""}`;
}

/**
 * How long a delay is, in the unit it is stated in: `15 min`, `12 h`, `3 days`.
 * A delay under two hours that is not a whole hour stays in minutes.
 */
export function delayLength(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole >= 2 * MINUTES_PER_DAY && whole % MINUTES_PER_DAY === 0) return `${whole / MINUTES_PER_DAY} days`;
  if (whole >= 60 && whole % 60 === 0) return `${whole / 60} h`;
  if (whole < 120) return `${whole} min`;
  return `${Math.round(whole / 60)} h`;
}

/** `15 min delayed`, `15-20 min delayed` across venues, or `delayed` when the feed does not say. */
function delayedText(freshness: Pick<ReportFreshness, "delayMinutes" | "minDelayMinutes">): string {
  const most = freshness.delayMinutes;
  if (!most) return "delayed";
  const least = freshness.minDelayMinutes;
  if (least && least < most) {
    const [low, lowUnit] = delayLength(least).split(" ");
    const [high, highUnit] = delayLength(most).split(" ");
    return lowUnit === highUnit ? `${low}-${high} ${highUnit} delayed` : `up to ${delayLength(most)} delayed`;
  }
  return `${delayLength(most)} delayed`;
}

function ageText(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

/** `short` counts stale rows without their total (`2 stale`), for a narrow capture. */
function statusText(freshness: ReportFreshness, short = false): string {
  switch (freshness.status) {
    case "live":
      return "live";
    case "delayed":
      return delayedText(freshness);
    case "stale": {
      if (freshness.staleCount != null && freshness.observationCount != null) {
        const rest = freshness.feed === "live" ? "live" : freshness.feed === "delayed" ? delayedText(freshness) : null;
        const count = short ? `${freshness.staleCount}` : `${freshness.staleCount} of ${freshness.observationCount}`;
        return `${rest ? `${rest}, ` : ""}${count} stale`;
      }
      // A line that says how old its oldest observation is does not say it twice.
      return freshness.ageMinutes != null && freshness.oldestAgeMinutes == null ? `stale (${ageText(freshness.ageMinutes)} old)` : "stale";
    }
    case "not-a-feed":
      return freshness.basis ? `not a live feed (${freshness.basis})` : "not a live feed";
    case "unreported":
      return "status not reported";
    default: {
      const _exhaustive: never = freshness.status;
      return _exhaustive;
    }
  }
}

/** Whether an ISO instant falls on the UTC day the report was built. */
function onRetrievalDay(iso: string, retrievedAt: string): boolean {
  return iso.slice(0, 10) === retrievedAt.slice(0, 10);
}

/**
 * The dated as-of: a session close, a UTC time, a date, or when the report was
 * retrieved; with the oldest observation unless `short`, or when the line says
 * how old the oldest is instead. `undated` leaves the day off a time of the
 * day the report was built, as a pane footer reads today.
 */
function asOfText(freshness: ReportFreshness, short: boolean, local: boolean, undated = false): string {
  if (!freshness.asOf) return `retrieved ${timeText(freshness.retrievedAt, local)}`;
  const market = freshness.tradingDayMarket;
  const period = freshness.periodicity;
  const time = parseReportTime(freshness.asOf);
  const asOf = period ? `${periodText(freshness.asOf, period)} (${period})`
    : freshness.asOfClose
      ? `${tradingDayText(freshness.asOfClose, market)} close`
      : time?.dateOnly ? tradingDayText(freshness.asOf, market)
        : undated && time && onRetrievalDay(new Date(time.time).toISOString(), freshness.retrievedAt)
          ? `${new Date(time.time).toISOString().slice(11, 16)} UTC` : timeText(freshness.asOf, local);
  const oldest = freshness.oldest && (period ? periodText(freshness.oldest, period) : dayText(freshness.oldest));
  return oldest && !short && freshness.oldestAgeMinutes == null ? `${asOf} (oldest ${oldest})` : asOf;
}

/**
 * Each source's own as-of, the zone named once at the end:
 * `Sun 11 Oct 2026 · Binance 02:15 · Bybit 02:24 UTC`. The day leads, the newest source's,
 * and a source observed on another day carries its own (`Binance Sat 10 Oct
 * 23:58`). `undated` leaves the leading day off when it is the day the report
 * was built.
 */
function sourcesAsOfParts(freshness: ReportFreshness, sources: readonly ReportSourceAsOf[], undated: boolean): string[] {
  const times = sources.map(({ source, asOf }) => ({ source, iso: new Date(Date.parse(asOf)).toISOString() }));
  const day = times.reduce((latest, { iso }) => (iso > latest ? iso : latest), "").slice(0, 10);
  const parts = times.map(({ source, iso }) => {
    const date = iso.slice(0, 10) === day ? "" : `${dayText(iso).replace(/ \d{4}$/, "")} `;
    return `${source} ${date}${iso.slice(11, 16)}`;
  });
  parts[parts.length - 1] += " UTC";
  return undated && onRetrievalDay(day, freshness.retrievedAt) ? parts : [dayText(day), ...parts];
}

/**
 * When the first venue opens again: its UTC time when that is later the same
 * UTC day, else its weekday at the venue (`Mon`), with the date a week out.
 */
function reopenText(market: ReportMarket, now: number, local: boolean): string | null {
  if (!market.reopensAt || !market.reopensOn) return null;
  const at = Date.parse(market.reopensAt);
  if (!Number.isFinite(at)) return null;
  const iso = new Date(at).toISOString();
  if (iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return `${iso.slice(11, 16)} UTC${local ? localTimeSuffix(at) : ""}`;
  return at - now > WEEKDAY_ONLY_MS ? dayText(market.reopensOn) : WEEKDAYS[new Date(`${market.reopensOn}T00:00:00Z`).getUTCDay()]!;
}

/** `markets closed until Mon`; `short` is the compact form a narrow capture falls back to (`reopens Mon`). */
function marketText(market: ReportMarket, now: number, short: boolean, local: boolean): string {
  const reopen = reopenText(market, now, local);
  switch (market.state) {
    case "open":
      return short ? "open" : "markets open";
    case "after-hours":
      return "after hours";
    case "pre-market":
      return reopen ? `pre-market, opens ${reopen}` : "pre-market";
    case "closed":
      if (short) return reopen ? `reopens ${reopen}` : "closed";
      return reopen ? `markets closed until ${reopen}` : "markets closed";
    default: {
      const _exhaustive: never = market.state;
      return _exhaustive;
    }
  }
}

interface StatusLineDetail {
  /** Leave out the oldest observation. */
  asOf?: "short";
  /** Count stale rows without their total. */
  status?: "short";
  /** `reopens Mon` for `markets closed until Mon`; `none` leaves the market out. */
  market?: "short" | "none";
  /** Leave out the reader's local time beside UTC times. */
  local?: "none";
  /** Leave the day off a time of the day the report was built. */
  date?: "none";
  /** Leave out what the figures are (`funding = current estimate`). */
  note?: "none";
}

/**
 * The parts of a report's status line: the dated as-of (each source's, when
 * it names several), how old the oldest observation is when it says, how
 * current the data is (`15 min delayed`, `live`), where its markets stand,
 * and what the figures are, when known.
 */
function statusLineParts(freshness: ReportFreshness, detail: StatusLineDetail = {}): string[] {
  const now = Date.parse(freshness.retrievedAt);
  const local = detail.local !== "none";
  const undated = detail.date === "none";
  return [
    ...(freshness.sources?.length ? sourcesAsOfParts(freshness, freshness.sources, undated)
      : [asOfText(freshness, detail.asOf === "short", local, undated)]),
    ...(freshness.oldestAgeMinutes != null ? [`oldest ${ageText(freshness.oldestAgeMinutes)}`] : []),
    statusText(freshness, detail.status === "short"),
    ...(freshness.market && detail.market !== "none" ? [marketText(freshness.market, now, detail.market === "short", local)] : []),
    ...(freshness.note && detail.note !== "none" ? [freshness.note] : []),
  ];
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** `Sun 4 Oct`, with the year only when it is not the year of the capture, which the lag counts from. */
function observedDayText(date: string, retrievedAt: string): string {
  const text = dayText(date);
  return date.slice(0, 4) === retrievedAt.slice(0, 4) ? text.replace(/ \d{4}$/, "") : text;
}

interface DatasetLineDetail {
  /** Leave out the source. */
  source?: "none";
  /** Leave out the oldest observation. */
  oldest?: "none";
  /** Count stale rows without their total. */
  status?: "short";
}

/**
 * A dataset's status line: its source, the newest observation's date (the
 * period, for monthly to annual data) and how many days it lags, then which
 * rows are stale, if any. No market part: a dataset has no session.
 */
function datasetLineParts(freshness: ReportFreshness, asOf: string, lagDays: number, detail: DatasetLineDetail = {}): string[] {
  const period = freshness.periodicity;
  const dated = (date: string) => (period ? periodText(date, period) : observedDayText(date, freshness.retrievedAt));
  const oldest = freshness.oldest && detail.oldest !== "none" ? ` (oldest ${dated(freshness.oldest)})` : "";
  const partly = freshness.staleCount != null && freshness.observationCount != null;
  const stale = freshness.status !== "stale" ? null
    : !partly ? "stale"
      : detail.status === "short" ? `${freshness.staleCount} stale` : `${freshness.staleCount} of ${freshness.observationCount} stale`;
  return [
    ...(detail.source === "none" ? [] : [`Source: ${freshness.source}`]),
    `observed ${dated(asOf)}${period ? ` (${period})` : ""}${oldest}`,
    `lag ${lagDays}d`,
    ...(stale ? [stale] : []),
  ];
}

/**
 * The plain status line of a capture: the longest of `statusLineVariants`,
 * `Fri 9 Oct close · 15 min delayed · markets closed until Mon` for quotes.
 */
export function formatStatusLine(freshness: ReportFreshness): string {
  return statusLineVariants(freshness)[0]!;
}

/** Whether the status line dates the data by its newest observation and lag (a dataset's), not by a market session. */
function datesObservation(freshness: ReportFreshness): freshness is ReportFreshness & { asOf: string; lagDays: number } {
  return freshness.lagDays != null && !!freshness.asOf;
}

/**
 * Whether the status line dates the data itself, so a capture leaves out the
 * pane's own `as of` segment: a dataset's line, or one that dates each source.
 */
export function datesPaneData(freshness: ReportFreshness): boolean {
  return datesObservation(freshness) || (freshness.sources?.length ?? 0) > 0;
}

/**
 * The status line a pane's footer shows, the one its report and capture end
 * with: without the reader's local time, and without the day when the data is
 * from the day it is read.
 */
export function paneStatusLine(freshness: ReportFreshness): string {
  return paneStatusLineVariants(freshness)[0]!;
}

/**
 * `paneStatusLine` from longest to shortest, for a footer to show the first
 * that fits beside its keys: the market part shortens, the stale total goes,
 * then what the figures are.
 */
export function paneStatusLineVariants(freshness: ReportFreshness): string[] {
  const pane: StatusLineDetail = { local: "none", date: "none" };
  const details: StatusLineDetail[] = [pane, { ...pane, market: "short" }, { ...pane, market: "short", status: "short" }, { ...pane, market: "short", status: "short", note: "none" }];
  return [...new Set(details.map((detail) => capitalize(statusLineParts(freshness, detail).join(" · "))))];
}

/**
 * The status line from longest to shortest, for a capture to take the first
 * that fits its width. Quotes and other reports leave out their source: the
 * date and the delay stay to the last; the market part shortens, then the
 * reader's local time, the oldest observation and the stale total go, then
 * the market part. With `source`, the line starts as `fn` ends,
 * `Source: CFTC · Tue 6 Oct 2026 · not a live feed (weekly report)`, shortens
 * the same way and gives up its source last. A dataset reads
 * `Source: Gloom Cloud · observed Sun 4 Oct · lag 6d` and gives up its oldest
 * observation, the stale total, then its source.
 */
export function statusLineVariants(freshness: ReportFreshness, { source = false }: { source?: boolean } = {}): string[] {
  if (datesObservation(freshness)) {
    const { asOf, lagDays } = freshness;
    const datasetDetails: DatasetLineDetail[] = [
      {},
      { oldest: "none" },
      { oldest: "none", status: "short" },
      { source: "none", oldest: "none", status: "short" },
    ];
    return [...new Set(datasetDetails.map((detail) => capitalize(datasetLineParts(freshness, asOf, lagDays, detail).join(" · "))))];
  }
  const details: StatusLineDetail[] = [
    {},
    { market: "short" },
    { market: "short", local: "none" },
    { asOf: "short", market: "short", local: "none" },
    { asOf: "short", status: "short", market: "short", local: "none" },
    { asOf: "short", status: "short", market: "none", local: "none" },
  ];
  // A line that dates each source keeps every source's time and their age to
  // the last: its day goes first, then what the figures are.
  const shortest = details.at(-1)!;
  const variants: StatusLineDetail[] = freshness.sources?.length
    ? [{}, ...details.map((detail) => ({ ...detail, date: "none" as const })), { ...shortest, date: "none", note: "none" }]
    : freshness.note ? [...details, { ...shortest, note: "none" }] : details;
  const lines = [...new Set(variants.map((detail) => capitalize(statusLineParts(freshness, detail).join(" · "))))];
  // A line that dates each source names them already.
  if (!source || freshness.sources?.length) return lines;
  const sourced = [...new Set(variants.map((detail) => [`Source: ${freshness.source}`, ...statusLineParts(freshness, detail)].join(" · ")))];
  const floor = sourced.at(-1)!.length;
  return [...sourced, ...lines.filter((line) => line.length < floor)];
}

/** A capture's status line: the facts it states (its `freshness` in JSON) and its text, longest first. */
export interface CaptureStatusLine {
  freshness: ReportFreshness;
  variants: string[];
}

/**
 * What a capture's status line says about its data, from the first that applies:
 * - a dataset's report (CHOKE's transits, HIRE's postings): its source, newest observation and lag;
 * - a pane that dates its own view (PERP's venues, FXC's rates, the news wire's delay): what it publishes;
 * - quotes on screen, when the pane does not say what its data is: their session, delay and market;
 * - the pane's report, when it says how current its data is: the line `fn` ends with, source first;
 * - otherwise what the rendered view carries, which may be nothing.
 */
export function captureStatusLine({ report, selfDated, quoted, rendered }: {
  /** The pane's own report, loaded for the capture: what `fn` would say. */
  report?: ReportFreshness;
  /** Whether the rendered pane published how current its view is. */
  selfDated: boolean;
  /** The quotes the capture shows, read when the pane does not say what its data is. */
  quoted?: ReportFreshness;
  rendered: () => ReportFreshness;
}): CaptureStatusLine {
  const plain = (freshness: ReportFreshness): CaptureStatusLine => ({ freshness, variants: statusLineVariants(freshness) });
  if (report && datesObservation(report)) return plain(report);
  if (selfDated) return plain(rendered());
  if (quoted) return plain(quoted);
  if (report && report.status !== "unreported") return { freshness: report, variants: statusLineVariants(report, { source: true }) };
  return plain(rendered());
}

/**
 * The one line every text report ends with, its source then its status line:
 * `Source: Gloom Cloud · Fri 9 Oct close · 15 min delayed · markets closed until Mon`.
 * Without a dated observation it says when the report was retrieved instead.
 * A line that dates each of its sources names them there, so it is the status
 * line alone: `Sun 11 Oct 2026 · Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed`.
 */
export function formatFreshnessLine(freshness: ReportFreshness): string {
  const parts = statusLineParts(freshness);
  return (freshness.sources?.length ? parts : [`Source: ${freshness.source}`, ...parts]).join(" · ");
}
