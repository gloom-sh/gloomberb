import { logFailure } from "../../utils/log-failure";
import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices, withConfigData, withMarketData } from "../context";
import { CLI_ERROR_CODE, failWithFields } from "../errors";
import type { CliResultColumn } from "../result";
import { formatCompact } from "../../utils/format";
import { DATE_OPTION_EXAMPLES, DATE_OPTION_FORMATS, dateOptionError, readCalendarDate } from "../../utils/calendar-date";
import {
  fetchPreferredMarketMovers,
  fetchTrending,
  MARKET_SUMMARY_SYMBOLS,
  type ScreenerCategory,
} from "../../plugins/builtin/market-movers/screener";
import {
  formatMoverPrice,
  MOVER_RANK_BASES,
  MOVER_RANKING_LABELS,
  moverReferencePrice,
  moverRegularSession,
  rankMoverQuotes,
  type MoverRankBasis,
} from "../../plugins/builtin/market-movers/model";
import { MOVER_CANDIDATES } from "../../plugins/builtin/market-movers/client";
import { hasPartialFloat, meetsMinFloat, minFloatShares, normalizeMinFloat, PARTIAL_FLOAT_NOTE } from "../../plugins/builtin/market-movers/min-float";
import { fetchEconCalendarFrom } from "../../plugins/builtin/econ/calendar-source";
import {
  attachFredSeriesPersistence, computedFredSeriesNote, loadCachedFredSeries, resetFredSeriesPersistence, seriesNotOnFred,
} from "../../sources/gloomberb-cloud/fred-series";
import type { CloudFredSeriesPayload } from "../../api-client";
import { savedCopyMark } from "../../data/saved-copies";
import { ratesMacroPluginMeta } from "../../plugins/builtin/builtin-plugin-meta";
import { createCommandPluginPersistence } from "../saved-copy-persistence";
import { EXTENDED_SESSION_LABELS, getQuoteSessionFields, type ExtendedSession } from "../../market-data/market/status";
import {
  COUNTRY_CYCLE,
  COUNTRY_FILTER_HINT,
  awaitsConsensus,
  countriesWithoutEvents,
  econEventName,
  FILTER_CYCLE,
  loadCalendar,
  eventCountry,
  matchesCountry,
  matchesEventSearch,
  matchesImpact,
  NO_CONSENSUS_NOTE,
  noScheduledReleasesMessage,
  parseCountryFilter,
  shortCalendarEnd,
  type CountryFilter,
  type ImpactFilter,
} from "../../plugins/builtin/econ/calendar-model";
import { hasNoReleaseTime, hasNoStatedTime, type EconEvent } from "../../plugins/builtin/econ/types";
import { econRowFigures } from "../../plugins/builtin/econ/figures";
import { isoDate, rejectExtraArgs, requireArg, requireOneArg, takeFlag, takeOption } from "./command-utils";
import { buildCorrelationSeries } from "../../plugins/builtin/correlation/matrix/model";
import { alignDailyCloses, correlateDailyCloses } from "../../plugins/builtin/correlation/compute";
import { mixedSessionCloseNote } from "../../market-data/market/session-close-note";
import { CORRELATION_RETURN_BASIS, loadCorrelationHistory } from "../../plugins/builtin/correlation/history";
import { EXCHANGE_OPTION, listingIdentity, listingReadNotes, loadForListing, loadListingQuote, requireCliListing, type CliListing } from "../listing-arg";
import { CLI_COMMAND_GROUPS } from "../help";
import { formatChangePercentCell, formatCompactCell } from "../helpers";
import { WORLD_INDICES } from "../../plugins/builtin/world-indices/indices";
import { getSectorCollection, SECTOR_COLLECTIONS } from "../../plugins/builtin/sectors/sector-data";
import { DAILY_CLOSES } from "../../plugins/builtin/shared/report-freshness";
import { canonicalTimeZone, localTimeSuffix, newestReportTime, oldestReportTime, timeZoneCity, zonedClock } from "../../utils/utc-time";
import { quotesFreshness, rowsFreshness } from "../freshness";
import { periodicityOf } from "../pane-functions/freshness";
import { formatBasisPoints, toBasisPoints } from "../../utils/basis-points";
import {
  basisPointsCell,
  DEFAULT_FRED_START,
  filterFredSeries,
  fredChangeCell,
  fredChangeFetchStart,
  fredChangeHeader,
  fredChangeMismatch,
  fredChanges,
  fredDecimals,
  fredEmptyAdvice,
  fredEmptyMessage,
  fredExportValue,
  fredHistoryNotes,
  fredInterval,
  fredObservesDays,
  fredObservationsFromStart,
  fredProvenance,
  fredPublicationTime,
  fredUnit,
  fredValueCell,
  fredValueHeader,
  isSpreadSeries,
  laggingSeriesNote,
  parseFredChange,
} from "./fred-series";

// Batch quotes often omit names for indices and ETFs; these baskets are fixed, so name them here.
const BASKET_NAMES = new Map<string, string>([
  ...WORLD_INDICES.map((entry) => [entry.symbol, entry.name] as const),
  ...SECTOR_COLLECTIONS.flatMap((collection) => collection.items.map((item) => [item.etf, item.name] as const)),
]);
// Priced like the MOST pane. Index and yield levels (^GSPC, ^TNX) carry no currency sign.
function formatRowPrice(value: unknown, row: Record<string, unknown>): string {
  return typeof value === "number"
    ? formatMoverPrice(
      value,
      typeof row.currency === "string" && !String(row.symbol ?? "").startsWith("^") ? row.currency : "",
      moverReferencePrice(row as Parameters<typeof moverReferencePrice>[0]),
    ) : "";
}
const PRICE_COLUMN = { key: "price", header: "Last", align: "right" as const, format: formatRowPrice };

/**
 * A pre-market or after-hours print and its move from the regular close, as
 * `quote` gives it, in its own column beside Last and Chg%. Text drops a
 * column no row fills, so a table without an extended print stays as before.
 */
function extendedColumn(session: ExtendedSession) {
  return {
    key: session === "PRE" ? "preMarket" : "afterHours",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right" as const,
    value: (row: Record<string, unknown>) => row.extendedSession === session ? row.extendedPrice : null,
    format: (value: unknown, row: Record<string, unknown>) => typeof value === "number"
      ? [formatRowPrice(value, row), formatChangePercentCell(row.extendedChangePercent)].join(" ").trim()
      : "",
  };
}
const EXTENDED_COLUMNS = [extendedColumn("PRE"), extendedColumn("POST")];
// A narrow terminal drops these before it cuts the names short.
const MARKET_CAP_CELL = { key: "marketCap", header: "Mkt Cap", align: "right" as const, optional: true, dropPriority: 1 };
const MOVER_COLUMNS = [
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  PRICE_COLUMN,
  { key: "changePercent", header: "Chg%", align: "right" as const, format: formatChangePercentCell },
  ...EXTENDED_COLUMNS,
  { key: "volume", header: "Volume", align: "right" as const, format: formatCompactCell },
  { ...MARKET_CAP_CELL, format: formatCompactCell },
];
const START_OPTION = {
  flags: "--start <date>",
  description: `First observation date, as ${DATE_OPTION_EXAMPLES}; yyyy or yyyy-mm start at the first of that year or month (default ${DEFAULT_FRED_START})`,
};

const MOVER_LISTS: Record<string, ScreenerCategory | "trending"> = {
  gainers: "day_gainers",
  losers: "day_losers",
  active: "most_actives",
  "most-active": "most_actives",
  trending: "trending",
};
const MOVERS_USAGE = "movers [gainers|losers|active|trending] [--session regular|extended] [--min-float <shares>]";
/** The most rows the movers list serves in one request. */
const MOVER_REQUEST_CAP = 100;
/** A one-shot list waits this long for its rows' average volumes and sizes, as `fn MOST` does. */
const MOVER_METADATA_WAIT_MS = 10_000;

function moverRankBasis(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): MoverRankBasis {
  if (value == null) return "regular";
  const basis = MOVER_RANK_BASES.find((candidate) => candidate === value.trim().toLowerCase());
  if (!basis) ctx.fail(`Unknown --session "${value}".`, "Use regular or extended.");
  return basis;
}

/** `--min-float` in shares, null for none; fails on a value that is not a share count. */
function moverMinFloat(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): number | null {
  if (value == null) return null;
  try {
    return minFloatShares(normalizeMinFloat(value));
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : String(error));
  }
}

function screenerCategory(args: readonly string[], ctx: Parameters<CliCommandDef["execute"]>[1]): ScreenerCategory | "trending" {
  rejectExtraArgs(args, 1, { usage: MOVERS_USAGE, takes: "one list" }, ctx);
  const list = args[0]?.toLowerCase() ?? "gainers";
  const category = MOVER_LISTS[list];
  if (!category) ctx.fail(`Unknown list "${args[0]}".`, "Use gainers, losers, active or trending.");
  return category;
}

/** A command that takes no arguments fails on one, rather than answering as if it were not there. */
function rejectArgs(args: readonly string[], usage: string, ctx: Parameters<CliCommandDef["execute"]>[1], advice?: string): void {
  rejectExtraArgs(args, 0, { usage, takes: "no arguments", advice }, ctx);
}

/** A percent to two decimals, as the table prints it. */
function roundedPercent(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(2));
}

function quoteRows(results: Awaited<ReturnType<NonNullable<import("../../types/data-provider").AssetDataProvider["getQuotesBatch"]>>>) {
  return results.map((result) => {
    const quote = result.quote;
    // Last and Chg% are the regular session, as `ticker` reads it; a pre-market or
    // after-hours print is its own column, measured from that session's close.
    const session = getQuoteSessionFields(quote);
    return {
      symbol: result.target.symbol,
      name: quote?.name || BASKET_NAMES.get(result.target.symbol) || "",
      price: session.price,
      change: session.change,
      changePercent: roundedPercent(session.changePercent),
      extendedSession: session.extendedSession,
      extendedPrice: session.extendedPrice,
      extendedChange: session.extendedChange,
      extendedChangePercent: roundedPercent(session.extendedChangePercent),
      currency: quote?.currency ?? "",
      providerId: quote?.providerId ?? "",
      marketCap: quote?.marketCap ?? null,
    };
  });
}

async function runMoverCommand(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const sessionOption = takeOption(args, "--session");
  const basis = moverRankBasis(sessionOption, ctx);
  const minFloat = moverMinFloat(takeOption(args, "--min-float"), ctx);
  const category = screenerCategory(args, ctx);
  const limit = ctx.cliOptions.limit ?? 25;
  if (sessionOption != null && (category === "trending" || category === "most_actives")) {
    ctx.fail("--session ranks Gainers and Losers.", category === "trending"
      ? "Trending keeps its source's order." : "Most active ranks by volume.");
  }
  if (minFloat != null && category === "trending") ctx.fail("--min-float filters Gainers, Losers and Most active.", "Trending carries no float.");
  if (category === "trending") {
    await withCliServices(ctx, async (services) => {
      const trending = await fetchTrending(limit, undefined, { forceRefresh: ctx.cliOptions.refresh });
      const results = await services.dataProvider.getQuotesBatch(
        trending.map(({ symbol }) => ({ symbol, exchange: "" })),
        { forceRefresh: ctx.cliOptions.refresh },
      );
      ctx.printResult({ data: quoteRows(results), metadata: { category }, freshness: quotesFreshness(results.map((result) => result.quote)) }, {
        textColumns: MOVER_COLUMNS.filter((column) => column.key !== "volume"),
      });
    });
    return;
  }

  // After the close a price list keeps only the rows moving its way on the basis
  // asked for, and a minimum float drops rows, so they read more candidates than they show.
  const count = category === "most_actives" && minFloat == null ? limit : Math.min(MOVER_REQUEST_CAP, Math.max(limit, MOVER_CANDIDATES));
  // With the saved session, as MOST reads it: a Pro account gets the real-time lists, anyone else the delayed ones.
  const movers = await withMarketData(ctx, () =>
    fetchPreferredMarketMovers(category, count, { forceRefresh: ctx.cliOptions.refresh, session: basis, metadataWaitMs: MOVER_METADATA_WAIT_MS }));
  // Last and Chg% are the regular session, as `ticker` reads it, and a
  // pre-market or after-hours print is its own column. The list is ranked by
  // the regular session's move (its close's after the close), or with
  // --session extended by the extended print's move from that close.
  const { quotes, rankedBy } = rankMoverQuotes(category, movers.quotes.map(moverRegularSession), basis);
  const rows = quotes.filter((quote) => meetsMinFloat(quote.floatShares, minFloat)).slice(0, limit).map((quote) => {
    const { extended, ...row } = quote;
    return {
      ...row,
      extendedSession: extended?.session ?? null,
      extendedPrice: extended?.price ?? null,
      extendedChange: extended?.change ?? null,
      extendedChangePercent: extended?.changePercent ?? null,
    };
  });
  const fellBack = basis === "extended" && rankedBy === "regular";
  // As the MOST report reads it: real-time for a Pro account, delayed otherwise, each row dated by its own last price.
  ctx.printResult({
    data: rows,
    metadata: { category, rankedBy, ...(minFloat != null ? { minFloat } : {}) },
    ...(fellBack ? { warnings: ["No pre-market or after-hours prints now, so the list is ranked by the regular-session move."] } : {}),
    freshness: rowsFreshness(rows, { status: movers.source === "cloud" ? "live" : "delayed" }, { stale: movers.stale }),
  }, {
    heading: `Ranked by ${MOVER_RANKING_LABELS[rankedBy]}`,
    ...(minFloat != null && hasPartialFloat(rows) ? { footnote: PARTIAL_FLOAT_NOTE } : {}),
    columns: [
      ...MOVER_COLUMNS.slice(0, 4),
      ...EXTENDED_COLUMNS,
      { key: "volume", header: "Volume", align: "right", value: (row) => formatCompact(Number(row.volume)) },
      { ...MARKET_CAP_CELL, value: (row) => row.marketCap == null ? "" : formatCompact(Number(row.marketCap)) },
      ...(minFloat != null ? [{ key: "floatShares", header: "Float", align: "right" as const, value: (row: Record<string, unknown>) => formatCompact(Number(row.floatShares)) }] : []),
    ],
  });
}

async function runQuoteBasket(symbols: string[], ctx: Parameters<CliCommandDef["execute"]>[1], metadata: Record<string, unknown>) {
  await withCliServices(ctx, async (services) => {
    const results = await services.dataProvider.getQuotesBatch(
      symbols.map((symbol) => ({ symbol, exchange: "" })),
      { forceRefresh: ctx.cliOptions.refresh },
    );
    ctx.printResult({ data: quoteRows(results), metadata, freshness: quotesFreshness(results.map((result) => result.quote)) }, {
      columns: [
        { key: "symbol", header: "Symbol" },
        { key: "name", header: "Name" },
        PRICE_COLUMN,
        { key: "changePercent", header: "Chg%", align: "right", format: formatChangePercentCell },
        ...EXTENDED_COLUMNS,
        { ...MARKET_CAP_CELL, value: (row) => row.marketCap == null ? "" : formatCompact(Number(row.marketCap)) },
      ],
    });
  });
}

/**
 * The UTC date, or the UTC time with its zone named, of an event's timestamp;
 * with `readerClock`, the reader's configured clock beside it.
 */
function utcDateTimePart(value: unknown, part: "date" | "time", readerClock = true): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const iso = date.toISOString();
  return part === "date" ? iso.slice(0, 10) : `${iso.slice(11, 16)} UTC${readerClock ? localTimeSuffix(date.getTime()) : ""}`;
}

const ECON_USAGE = "econ [--country <regions or countries>] [--impact <level>] [--search <words>] [--from <date>] [--tz <zone>]";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** "Sat" for 2026-10-31. */
const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;

/** Mon to Sun, so a release on a weekend (China's PMI on a Saturday) reads as one. */
const ECON_DAY_COLUMN = { key: "day", header: "Day", shrink: false };

/** A publisher's clock for a row it times itself: `13:00 Mexico City` from 13:00 in America/Mexico_City. */
function publisherClock(localTime: unknown, timeZone: unknown): string {
  if (typeof localTime !== "string" || !localTime || typeof timeZone !== "string" || !timeZone) return "";
  return `${localTime} ${timeZoneCity(timeZone)}`;
}
const DAY_MS = 86_400_000;

/** The calendar's columns up to the event: shared by the text table and the exports, which keep the raw values under them. */
function econHeadColumns(viewerZone: string | null): CliResultColumn[] {
  return [
    // Text shows both halves of the event timestamp in UTC, never the host's zone; exports keep the source values.
    { key: "date", header: "Date", format: (value) => utcDateTimePart(value, "date") },
    // The weekday sits before the clock it is on: the UTC time's, or with --tz the viewer's.
    ...viewerZone ? [] : [ECON_DAY_COLUMN],
    // With --tz the viewer's clock has its own column, so the UTC time does not repeat it.
    { key: "time", header: "Time", format: (value, row) => value === "All Day" ? "All day" : value === ""
      ? "" : utcDateTimePart(row.date, "time", !viewerZone) },
    ...viewerZone ? [ECON_DAY_COLUMN] : [],
    // Only --tz fills it: the viewer's clock, its weekday in Day before it.
    { key: "viewerTime", header: viewerZone ? timeZoneCity(viewerZone) : "Viewer", shrink: false,
      format: (value) => typeof value === "string" && viewerZone ? value : "" },
    // Only rows a publisher times itself fill it, so the feeds' calendar prints as before.
    { key: "localTime", header: "Local", optional: true, dropPriority: 1, format: (value, row) => publisherClock(value, row.timeZone) },
    { key: "country", header: "Country" },
    { key: "impact", header: "Impact" },
    { key: "event", header: "Event" },
  ];
}

/**
 * The text table's columns up to the event. Plain output keeps every column a
 * query has, so a column that is empty by construction has to be left out
 * here, not hidden by the table: the viewer's clock only exists with --tz, and
 * the publisher's own clock only on rows a bank or statistics office times
 * itself. Exports keep both, so a script's header never moves.
 */
function econTextHeadColumns(viewerZone: string | null, publisherTimed: boolean): CliResultColumn[] {
  return econHeadColumns(viewerZone).filter((column) => (
    column.key === "viewerTime" ? !!viewerZone : column.key === "localTime" ? publisherTimed : true
  ));
}

/**
 * Actual, Forecast and Prior: as the text draws them (`30.3K`, `-4.1M bbl`) in the table, as
 * numbers in the exports (30300, -4100000), where Unit and Scale say what they count and how they were drawn.
 */
function econFigureColumns(text: boolean): CliResultColumn[] {
  return text
    ? [{ key: "actualText", header: "Actual" }, { key: "forecastText", header: "Forecast" }, { key: "priorText", header: "Prior" }]
    : [{ key: "actual", header: "Actual" }, { key: "forecast", header: "Forecast" }, { key: "prior", header: "Prior" }];
}

const ECON_PUBLISHER_COLUMN: CliResultColumn = {
  key: "publisher", header: "Publisher", format: (value) => typeof value === "string" ? value : "",
};

/** What only the exports say about a row: how to read its figures, who publishes it and where, and the figures as drawn. */
const econExportColumns: CliResultColumn[] = [
  { key: "unit", header: "Unit" },
  { key: "scale", header: "Scale" },
  { key: "publisher", header: "Publisher" },
  { key: "sourceUrl", header: "Link" },
  // The figures as the calendar draws them, so a bound (`<1.25%`) that is no number keeps its text.
  { key: "actualText", header: "actual_text" },
  { key: "forecastText", header: "forecast_text" },
  { key: "priorText", header: "prior_text" },
  // Which feed the forecast was read from and when, so a consensus can be told from another read of it.
  { key: "consensusFeed", header: "consensus_feed" },
  { key: "consensusReadAt", header: "consensus_read_at" },
];

/**
 * What an empty calendar says. A window that starts after the last day listed
 * says where the listing stops, whatever the filters, rather than nothing.
 */
function econEmptyMessage(from: string | null, listedThrough: string | null, stopsShort: boolean): string {
  if (!listedThrough) return "No events listed.";
  if (from != null && from > listedThrough) return `No events listed after ${listedThrough}.`;
  const range = from ? ` from ${from}` : "";
  return stopsShort
    ? `No matching events${range}; none listed after ${listedThrough}.`
    : `No matching events${range} through ${listedThrough}.`;
}

/**
 * A date option, read as an ISO date; null when it was not given. `expand`
 * reads a shorthand as a full date first, and `form` is how the message names
 * what the option takes.
 */
function parseDateOption(
  value: string | undefined,
  flag: string,
  ctx: Parameters<CliCommandDef["execute"]>[1],
  { expand = (text: string) => text, form = DATE_OPTION_FORMATS }: { expand?: (text: string) => string; form?: string } = {},
): string | null {
  if (value == null) return null;
  const date = readCalendarDate(expand(value.trim()));
  if (!date) ctx.fail(dateOptionError(value, flag, { formats: form }));
  return date;
}

/** One of a filter's values, matched without regard to case; anything else fails with the list. */
function parseFilter<T extends string>(value: string | undefined, values: readonly T[], label: string, ctx: Parameters<CliCommandDef["execute"]>[1]): T {
  if (value == null) return values[0]!;
  const match = values.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
  if (!match) ctx.fail(`Unknown ${label} "${value}".`, `Use ${values.join(", ")}.`);
  return match;
}

/** The pane's regions and ISO country codes, comma separated (`MX,BR,ZA`, `G7,MX`); upper-cased. */
function parseCountry(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): CountryFilter {
  if (value == null) return COUNTRY_CYCLE[0]!;
  const parsed = parseCountryFilter(value);
  return "error" in parsed ? ctx.fail(parsed.error, COUNTRY_FILTER_HINT) : parsed.filter;
}

/** Blank times, each with why: a bank whose calendar gives the day and not the time. */
function blankTimeNotes(rows: ReadonlyArray<{ event: string; country: string; timeNote: string | null }>): string[] {
  const byNote = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.timeNote) continue;
    const named = `${row.event} (${row.country})`;
    const events = byNote.get(row.timeNote) ?? [];
    if (!events.includes(named)) events.push(named);
    byNote.set(row.timeNote, events);
  }
  return [...byNote].map(([note, events]) => `No time for ${events.join(", ")}: ${note.charAt(0).toLowerCase()}${note.slice(1)}.`);
}

/**
 * Whether a row has come out: it has an actual, or it has no figure at all (a
 * speech, a meeting, a holiday) and its time has passed. A row with a forecast
 * or a prior and no actual is still to come, whatever its time.
 */
function cameOut(event: Pick<EconEvent, "actual" | "forecast" | "prior" | "date">, now: number): boolean {
  if (event.actual?.trim()) return true;
  return !event.forecast?.trim() && !event.prior?.trim() && event.date.getTime() <= now;
}

/**
 * A `--from` the stored calendar does not reach back to, which Gloom Cloud refuses
 * with "The calendar reaches back 400 days": an input error naming the earliest
 * day it takes, and `--json` carries it as `earliest`. Any other failure goes on as it was.
 */
function failBeforeCalendar(error: unknown, from: string, todayStart: number): never {
  const days = error instanceof ApiRequestError && error.status === 422 ? /reaches back (\d+) days?/i.exec(error.message)?.[1] : undefined;
  if (!days) throw error;
  const earliest = isoDate(new Date(todayStart - Number(days) * DAY_MS)).slice(0, 10);
  return failWithFields(
    `--from ${from} is before the earliest day the calendar reaches back to, ${earliest}. Use --from ${earliest} or later.`,
    CLI_ERROR_CODE,
    { earliest, days: Number(days) },
  );
}

async function runEcon(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const rawArgs = [...args];
  const country = parseCountry(takeOption(rawArgs, "--country"), ctx);
  const impact: ImpactFilter = parseFilter(takeOption(rawArgs, "--impact"), FILTER_CYCLE, "impact", ctx);
  const search = takeOption(rawArgs, "--search")?.trim() ?? null;
  if (search === "") ctx.fail("--search needs the words of an event's name.", "Such as econ --search nonfarm.");
  const fromOption = parseDateOption(takeOption(rawArgs, "--from"), "--from", ctx);
  const tzOption = takeOption(rawArgs, "--tz");
  const viewerZone = tzOption == null ? null : canonicalTimeZone(tzOption);
  if (tzOption != null && !viewerZone) {
    ctx.fail(`Unknown time zone "${tzOption}".`, "Use an IANA zone name, such as America/New_York, Europe/London or Asia/Tokyo.");
  }
  rejectArgs(rawArgs, ECON_USAGE, ctx, "Filter with --country, --impact and --search.");
  await withCliServices(ctx, async () => {
    const now = Date.now();
    const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
    // An earlier day reads the stored calendar, which keeps past events after the week's listing drops them.
    // A server without it, a server error or no network lists the current calendar (cached when offline) instead.
    const stored = fromOption != null && fromOption < isoDate(new Date(todayStart))
      ? await fetchEconCalendarFrom(fromOption).catch((error: unknown) => failBeforeCalendar(error, fromOption, todayStart))
      : null;
    const past = stored?.events ? stored : null;
    const unread = stored && !stored.events && stored.failure ? `The stored calendar could not be read (${stored.failure}); listing the current calendar` : null;
    const { data: events, fetchedAt, stale, source } = past
      ? { data: past.events, fetchedAt: Date.now(), stale: false, source: "network" as const }
      : await loadCalendar(ctx.cliOptions.refresh);
    // The calendar lists from today (UTC). --from moves the first day; --tail
    // alone keeps the newest events of the whole calendar, the past week's too.
    const from = fromOption ?? (ctx.cliOptions.tail != null ? null : new Date(todayStart).toISOString().slice(0, 10));
    const fromTime = from == null ? Number.NEGATIVE_INFINITY : Date.parse(`${from}T00:00:00Z`);
    const lastEvent = events.reduce<Date | null>((last, event) => (!last || event.date > last ? event.date : last), null);
    const listedThrough = lastEvent ? lastEvent.toISOString().slice(0, 10) : null;
    // A calendar that stops short of a week ahead says so under the table.
    const listedAfter = shortCalendarEnd(events, Math.max(todayStart, fromTime)) ? `No events listed after ${listedThrough}` : null;
    // A day before anything the calendar holds says where its listing starts.
    const firstEvent = events.reduce<Date | null>((first, event) => (!first || event.date < first ? event.date : first), null);
    const listedFrom = firstEvent ? firstEvent.toISOString().slice(0, 10) : null;
    const startsLater = fromOption != null && (past ? past.storedFrom == null || past.storedFrom > fromOption : listedFrom != null && listedFrom > fromOption);
    const listedBefore = !startsLater ? null
      : past?.storedFrom ? `The stored calendar starts ${past.storedFrom}; nothing earlier is listed`
      : `No events are stored before ${listedFrom ?? isoDate(new Date(todayStart))}`;
    // Countries asked for that nothing in the window is for: a quiet week there, not an unknown country.
    const inWindow = events.filter((event) => event.date.getTime() >= fromTime);
    const unscheduled = countriesWithoutEvents(country, inWindow);
    const listed = inWindow
      .filter((event) => matchesCountry(event, country) && matchesImpact(event, impact) && (search == null || matchesEventSearch(event, search)))
      .sort((left, right) => left.date.getTime() - right.date.getTime());
    const rows = listed
      .map((event) => {
        // The viewer's clock (--tz) for a row with a time: its date and time there.
        const clock = viewerZone && !hasNoReleaseTime(event) ? zonedClock(event.date.getTime(), viewerZone) : null;
        // The figures as numbers, scale multiplied out, with their unit and the scale they are drawn in; the text stays as drawn.
        const figures = econRowFigures(event);
        return {
          date: isoDate(event.date),
          // The weekday on the viewer's clock (--tz), else the UTC day's; a row with no time is its day's.
          day: weekdayOf(clock?.date ?? isoDate(event.date).slice(0, 10)),
          time: hasNoStatedTime(event) ? "" : event.time,
          ...(viewerZone ? { viewerDate: clock?.date ?? null, viewerTime: clock?.time ?? null } : {}),
          country: eventCountry(event),
          impact: event.impact,
          // As the calendar names it: the Fed's decision is the upper bound of its range.
          event: econEventName(event),
          actual: figures.actual,
          forecast: figures.forecast,
          prior: figures.prior,
          unit: figures.unit,
          scale: figures.scale,
          actualText: event.actual ?? null,
          forecastText: event.forecast ?? null,
          priorText: event.prior ?? null,
          // The publisher's own clock, for rows Gloom Cloud adds from a bank's or a statistics office's calendar.
          localTime: event.localTime ?? null,
          timeZone: event.timeZone ?? null,
          timeNote: event.timeNote ?? null,
          priorAsOf: event.priorAsOf ?? null,
          // Who publishes the figure (Freddie Mac for the 30-year mortgage rate), the period it covers and its page.
          publisher: event.source?.name ?? null,
          referencePeriod: event.referencePeriod ?? null,
          // When the figure came out: the row's time once it has an actual, and for a row with no figures (a speech, a
          // meeting) once its time has passed; its day alone when it states no time, null before.
          released: cameOut(event, now) ? (hasNoReleaseTime(event) ? isoDate(event.date).slice(0, 10) : isoDate(event.date)) : null,
          sourceUrl: event.source?.url ?? null,
          // The same indicator from one release to the next, as Gloom Cloud names it.
          indicatorId: event.indicatorId ?? null,
          // The feed the forecast was read from and when, for a row with a forecast.
          consensusFeed: event.consensus?.source ?? null,
          consensusReadAt: event.consensus?.readAt ?? null,
        };
      });
    // A filter of countries only, none of which has anything in the window, says so as its empty list.
    const allUnscheduled = unscheduled.length > 0 && unscheduled.length === country.split(",").length;
    const notes = [listedBefore, listedAfter, ...(rows.length > 0 ? blankTimeNotes(rows) : []),
      rows.length > 0 && unscheduled.length > 0 ? noScheduledReleasesMessage(unscheduled) : null,
      // A dash under Forecast on a release still to come is a consensus not in yet, not a missing figure.
      listed.some(awaitsConsensus) ? NO_CONSENSUS_NOTE : null]
      .filter((note): note is string => !!note);
    const footnote = notes.join("\n");
    // The calendar as read, not its rows: those are scheduled, mostly ahead. One that could not be
    // refreshed is the copy an earlier read saved, and says when that was.
    const read = rowsFreshness([], { status: "not-a-feed", basis: "calendar", asOf: fetchedAt }, { stale });
    const calendarFreshness = read && source === "stale-fallback" ? { ...read, savedAt: new Date(fetchedAt).toISOString() } : read;
    ctx.printResult({
      data: rows,
      ...(unread ? { warnings: [unread] } : {}),
      metadata: { country, impact, ...(search != null ? { search } : {}), from, listedThrough, storedFrom: past?.storedFrom ?? null, ...(viewerZone ? { timeZone: viewerZone } : {}) },
      freshness: calendarFreshness,
    }, {
      dateKey: "date",
      defaultLimit: 50,
      empty: allUnscheduled ? noScheduledReleasesMessage(unscheduled) : econEmptyMessage(from, listedThrough, listedAfter != null),
      ...(footnote ? { footnote } : {}),
      // What the text says under the table, a script reads in the CSV's closing lines.
      exportNotes: notes,
      // `as_of` is the release: when a row's figure came out, blank for one that has none yet.
      exportDated: true,
      exportIdentity: (row) => ({
        symbolOrSeries: typeof row.indicatorId === "string" ? row.indicatorId : null,
        // A percent is `pct` here as in `fred` and `yield-curve`; `unit` keeps the `%` the calendar draws.
        currencyOrUnit: row.unit === "%" ? "pct" : typeof row.unit === "string" ? row.unit : null,
        asOf: typeof row.released === "string" ? row.released : null,
        released: typeof row.released === "string" ? row.released : null,
        period: typeof row.referencePeriod === "string" ? row.referencePeriod : null,
      }),
      // The exports add what a script needs to read a row; the text table keeps the columns it had.
      columns: [...econHeadColumns(viewerZone), ...econFigureColumns(false), ...econExportColumns],
      textColumns: [...econTextHeadColumns(viewerZone, rows.some((row) => !!publisherClock(row.localTime, row.timeZone))), ...econFigureColumns(true), ECON_PUBLISHER_COLUMN],
    });
  });
}

const FRED_USAGE = "fred <series-id> [--start <date>] [--sort desc|asc] [--change 1D|1W]";
const FRED_LIST_USAGE = "fred --list [filter]";

/** A year or a month stands for the first day of it. */
function startOfPeriod(text: string): string {
  if (/^\d{4}$/.test(text)) return `${text}-01-01`;
  return /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : text;
}

/** `--start`, checked here: Gloom Cloud cannot read anything but yyyy-mm-dd, so yyyy and yyyy-mm are spelled out. */
function parseStartDate(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): string {
  return parseDateOption(value, "--start", ctx, { expand: startOfPeriod, form: `${DATE_OPTION_FORMATS.replace(" or ", ", ")}, YYYY-MM or YYYY` }) ?? DEFAULT_FRED_START;
}

/** Gloom Cloud serves a curated set of FRED series and answers 400 for any other id. */
function isUnsupportedSeries(error: unknown): boolean {
  if (!(error instanceof ApiRequestError) || error.status !== 400) return false;
  const message = typeof error.details?.message === "string" ? error.details.message : error.message;
  return error.details?.code === "unsupported_series" || /^Unsupported FRED series\b/i.test(message);
}

/**
 * Runs `run` with the FRED series cache saving what it fetches in the profile,
 * where the app's rates and macro panes keep it: a refresh that fails then
 * answers from the copy an earlier read saved, and the report says so.
 */
function withSavedFredSeries<T>(ctx: Parameters<CliCommandDef["execute"]>[1], run: () => Promise<T>): Promise<T> {
  return withConfigData(ctx, async ({ persistence }) => {
    attachFredSeriesPersistence(createCommandPluginPersistence(persistence.resources, `plugin:${ratesMacroPluginMeta.stateId}`));
    try {
      return await run();
    } finally {
      resetFredSeriesPersistence();
    }
  });
}

/**
 * A FRED series from Gloom Cloud, or the copy an earlier read saved when it
 * cannot be refreshed (marked as such). A refusal (a series Gloom Cloud no
 * longer serves, access denied) is said, not covered: `loadCachedFredSeries`
 * throws it.
 */
async function loadFredSeries(
  seriesId: string,
  params: { startDate?: string; limit?: number; sortOrder: "asc" | "desc" },
): Promise<CloudFredSeriesPayload> {
  return (await loadCachedFredSeries({ seriesId, ...params }, () => apiClient.getCloudFredSeries(seriesId, params))).data;
}

async function runFredList(filter: string, ctx: Parameters<CliCommandDef["execute"]>[1]) {
  let catalog;
  try {
    catalog = await apiClient.getCloudFredSeriesCatalog();
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) ctx.fail("The list of supported FRED series is not available yet.");
    throw error;
  }
  const rows = filterFredSeries(
    catalog.series.map((series) => ({ id: series.id, title: series.title?.trim() ?? "", group: series.group?.trim() ?? "" })),
    filter,
  );
  ctx.printResult({ data: rows, metadata: { filter: filter || null, total: catalog.series.length } }, {
    columns: [
      { key: "id", header: "ID", shrink: false },
      // A title too narrow to tell series apart goes on a line under its ID.
      { key: "title", header: "Title", minWidth: 30, stackPriority: 1 },
      { key: "group", header: "Group", shrink: false },
    ],
    empty: filter ? `No supported FRED series match "${filter}". Run gloom fred --list to see them all.` : "No FRED series are listed.",
  });
}

async function runFred(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const list = takeFlag(args, "--list");
  const start = takeOption(args, "--start");
  const sort = takeOption(args, "--sort");
  const changeGiven = args.some((arg) => arg === "--change" || arg.startsWith("--change="));
  const change = changeGiven ? takeOption(args, "--change") : undefined;
  // Bare `fred` lists the series it can fetch, grouped by topic, as `fred --list` does.
  if (list || rawArgs.length === 0) {
    if (start != null || sort != null || changeGiven) {
      ctx.fail("--list takes a filter, not --start, --sort or --change.", `Usage: gloom ${FRED_LIST_USAGE}`);
    }
    return runFredList(args.join(" ").trim(), ctx);
  }
  const startDate = parseStartDate(start, ctx);
  const sortOrder = (sort ?? "desc").trim().toLowerCase();
  if (sortOrder !== "asc" && sortOrder !== "desc") ctx.fail(`Unknown sort order "${sort}".`, "Use desc (newest first) or asc.");
  const horizon = changeGiven ? parseFredChange(change) : null;
  if (changeGiven && !horizon) {
    ctx.fail(change ? `Unknown change "${change}".` : "--change needs 1D or 1W.", "Use 1D (from the previous observation) or 1W (from a week before).");
  }
  const seriesId = requireOneArg(args, FRED_USAGE, "series", ctx).toUpperCase();
  await withSavedFredSeries(ctx, () => printFredSeries(ctx, { seriesId, start, startDate, sortOrder, horizon }));
}

async function printFredSeries(ctx: Parameters<CliCommandDef["execute"]>[1], { seriesId, start, startDate, sortOrder, horizon }: {
  seriesId: string;
  start: string | undefined;
  startDate: string;
  sortOrder: "asc" | "desc";
  horizon: ReturnType<typeof parseFredChange>;
}) {
  // A change needs the observation it is measured from: the fetch reaches back before the first row shown.
  const fetchStart = horizon ? fredChangeFetchStart(startDate) : startDate;
  const data = await loadFredSeries(seriesId, { startDate: fetchStart, sortOrder }).catch((error: unknown) => {
    if (isUnsupportedSeries(error)) ctx.fail(`Unsupported FRED series ${seriesId}. List supported series with: gloom fred --list`);
    throw error;
  });
  // Every observation exports as `value`, a spread in basis points; its unit goes in the `currency_or_unit` column.
  const unit = fredUnit(seriesId, data.info);
  const interval = fredInterval(data.info?.frequency);
  const mismatch = horizon ? fredChangeMismatch(seriesId, interval, horizon) : null;
  if (mismatch) ctx.fail(mismatch);
  // Each row's change in the unit its value exports in, and the date it is from; a holiday's stays blank.
  const changes = horizon ? fredChanges(seriesId, data.observations, horizon) : null;
  const releasedOf = (observation: { publisher?: string; publishedAt?: string; releasedOn?: string }) =>
    observation.releasedOn ?? (observation.publisher?.trim() ? observation.publishedAt : undefined);
  // A value FRED does not list yet carries its publisher and when it published, in every export.
  // A row from the copy an earlier read saved, the refresh having failed, carries its mark: the source line says so.
  const exportRow = (observation: { date: string; value: number | null; publisher?: string; publishedAt?: string; releasedOn?: string }) => ({
    ...savedCopyMark(data),
    date: observation.date,
    value: fredExportValue(seriesId, observation.value),
    ...(changes ? { change: changes.get(observation.date)?.change ?? null, changeFrom: changes.get(observation.date)?.changeFrom ?? null } : {}),
    ...(observation.publisher?.trim() ? { publisher: observation.publisher.trim(), ...(observation.publishedAt ? { publishedAt: observation.publishedAt } : {}) } : {}),
    // When the figure came out, where the data says: only a series' newest observation does. `date` is the period it covers.
    ...releasedOf(observation) ? { released: releasedOf(observation) } : {},
  });
  // A --start before the series begins comes back padded with blank days: the rows start at its first observation.
  const rows = fredObservationsFromStart(data.observations, data.info?.observationStart)
    .filter((observation) => !horizon || observation.date >= startDate)
    .map(exportRow);
  // The default start hides older history and a start before the series begins is moved up silently: say where it really starts.
  const notes = [
    ...fredHistoryNotes({ startDate, startGiven: start != null, seriesStart: data.info?.observationStart }),
    laggingSeriesNote(seriesId),
    computedFredSeriesNote(seriesId),
  ].filter((note): note is string => note != null);
  // Nothing on or after the start: name where the series ends, so an empty answer is not a dead end.
  const latest = rows.length > 0 ? null : await loadFredSeries(seriesId, { limit: 1, sortOrder: "desc" })
    .then((payload) => payload.observations[0] ?? null).catch(logFailure("cli.commands-overview", "Read latest economic series observation failed", null));
  // CSV and NDJSON are rows alone: an empty one would read as a series with no data, so it fails and says where the series ends.
  if (rows.length === 0 && (ctx.cliOptions.format === "csv" || ctx.cliOptions.format === "ndjson")) {
    ctx.fail(`No ${seriesId} observations on or after ${startDate}.`, fredEmptyAdvice(seriesId, latest));
  }
  const periodicity = periodicityOf(data.info?.frequency);
  const observesDays = fredObservesDays(data.info?.frequency);
  const newestDate = rows.reduce<string | null>((newest, row) => (!newest || row.date > newest ? row.date : newest), null);
  // A newest value FRED does not list yet names its publisher, Treasury for a yield; FRED's own stay "FRED".
  const ahead = fredProvenance(data.observations.filter((observation) => observation.date === newestDate), seriesId);
  // FRED names the series' publisher when Gloom Cloud passes it on, and when it last updated the series.
  const publisher = ahead?.publisher ?? data.info?.source?.trim();
  const publishedAt = ahead ? ahead.publishedAt : fredPublicationTime(data.info, newestDate);
  // When the newest figure was released: the report is as of then, `Sep 2026, released Tue 20 Oct`.
  const releasedOn = ahead ? undefined : data.observations.find((observation) => observation.date === newestDate)?.releasedOn;
  ctx.printResult({
    data: rows,
    metadata: {
      info: data.info, seriesId, startDate, sortOrder, unit, interval,
      ...(horizon ? { change: horizon } : {}),
      ...(notes.length ? { notes } : {}),
      ...(latest ? { latestObservation: exportRow(latest) } : {}),
    },
    freshness: rowsFreshness(rows, {
      source: ahead?.source ?? notOnFredSource(seriesId) ?? "FRED", status: "not-a-feed", basis: "published statistics", observedKey: "date", oldest: null,
      // A monthly or quarterly observation is dated the first of its period, not a day it was seen.
      ...(periodicity ? { periodicity } : {}),
      ...(releasedOn ? { releasedOn } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }),
  }, {
    dateKey: "date",
    empty: fredEmptyMessage(startDate, latest == null ? null : exportRow(latest)),
    ...(notes.length ? { footnote: notes.join("\n"), exportNotes: notes } : {}),
    // `as_of` is the release. A figure with none stated is as of its own day when the series is known to observe
    // days (a daily or weekly rate), and of nothing otherwise, never the first day of the period it covers.
    exportDated: true,
    exportIdentity: (row) => {
      const released = typeof row.released === "string" ? row.released : null;
      const date = typeof row.date === "string" ? row.date : null;
      return { symbolOrSeries: seriesId, currencyOrUnit: unit, interval, asOf: released ?? (observesDays ? date : null), period: date, released };
    },
    // The release closes the row with the other dating columns, so it is not one of the observation's own.
    columns: [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => key !== "released").map((key) => ({ key, header: key })),
    textColumns: [
      { key: "date", header: "Date" },
      isSpreadSeries(seriesId)
        ? { key: "value", header: "Value (bp)", align: "right", format: basisPointsCell }
        : { key: "value", header: fredValueHeader(data.info), align: "right", format: fredValueCell(fredDecimals(rows.map((row) => row.value))) },
      ...(horizon ? [{
        key: "change", header: fredChangeHeader(seriesId, horizon, data.info), align: "right" as const,
        format: fredChangeCell(isSpreadSeries(seriesId), fredDecimals(rows.map((row) => row.value))),
      }] : []),
    ],
  });
}

/** Who a series FRED does not carry comes from, for a source line whose rows do not name it: `TurkStat via the CBRT`. */
function notOnFredSource(seriesId: string): string | null {
  const elsewhere = seriesNotOnFred(seriesId);
  return elsewhere ? `${elsewhere.publisher} via ${elsewhere.via}` : null;
}

const YIELD_TENORS: Record<string, string> = { DGS3MO: "3M", DGS2: "2Y", DGS10: "10Y", DGS30: "30Y" };

async function runYieldCurve(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const startDate = parseStartDate(takeOption(args, "--start"), ctx);
  rejectArgs(args, "yield-curve [--start <date>]", ctx);
  const series = Object.keys(YIELD_TENORS);
  const results = await withSavedFredSeries(ctx, () => Promise.all(series.map(async (seriesId) => {
    const data = await loadFredSeries(seriesId, { startDate, sortOrder: "desc" });
    const [latest, previous] = data.observations;
    return {
      // A tenor from the copy an earlier read saved, the refresh having failed, says so in the source line.
      ...savedCopyMark(data),
      seriesId,
      date: latest?.date ?? "",
      // Yields in percent, which the exports' `currency_or_unit` column says (`pct`), as `fred` does.
      value: latest?.value ?? null,
      title: data.info?.title ?? "",
      // The move since the previous observation FRED has, not calendar yesterday: a Monday reads against Friday.
      previousDate: previous?.date ?? null,
      previousValue: previous?.value ?? null,
      changeBasisPoints: latest?.value != null && previous?.value != null ? toBasisPoints(latest.value - previous.value, 1) : null,
      latest,
      publishedAt: latest?.publisher ? null : fredPublicationTime(data.info, latest?.date),
    };
  })));
  // Tenors whose latest yield FRED does not list yet name the Treasury and when it published them.
  const ahead = fredProvenance(results.flatMap((row) => row.latest ? [row.latest] : []));
  // The curve shown was published with its last tenor: the newest of their FRED updates, when each has one.
  const published = results.map((row) => row.publishedAt);
  const publishedAt = ahead ? ahead.publishedAt : published.every((time) => time != null) ? published.sort().at(-1) : null;
  ctx.printResult({
    data: results.map(({ publishedAt: _publishedAt, latest: _latest, ...row }) => row),
    metadata: { startDate },
    freshness: rowsFreshness(results, {
      source: ahead?.source ?? "FRED", status: "not-a-feed", basis: "daily Treasury yields", observedKey: "date",
      ...(ahead?.publisher ? { publisher: ahead.publisher } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }),
  }, {
    exportIdentity: (row) => ({ symbolOrSeries: String(row.seriesId), currencyOrUnit: "pct", interval: "daily" }),
    textColumns: [
      { key: "tenor", header: "Tenor", value: (row) => YIELD_TENORS[String(row.seriesId)] ?? row.seriesId },
      { key: "value", header: "Yield %", align: "right", format: (value) => typeof value === "number" ? value.toFixed(2) : "-" },
      {
        key: "changeBasisPoints",
        header: "1D bp",
        align: "right",
        format: (value) => typeof value === "number" ? formatBasisPoints(value / 100, 1) : "-",
      },
      { key: "date", header: "Date" },
      { key: "seriesId", header: "Series" },
    ],
  });
}

async function runCorrelation(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const exchange = takeOption(args, "--exchange");
  const usage = "correlation <symbol-a> <symbol-b>";
  requireArg(args[0], `Usage: gloom ${usage}`, ctx);
  requireArg(args[1], `Usage: gloom ${usage}`, ctx);
  rejectExtraArgs(args, 2, { usage, takes: "two symbols", advice: "Run it once per pair." }, ctx);
  await withCliServices(ctx, async (services) => {
    // --exchange is for a symbol that names no exchange of its own.
    const [leftListing, rightListing] = await Promise.all([args[0]!, args[1]!].map((raw) => (
      requireCliListing(raw, exchange, services, ctx, { ownExchangeWins: true })
    )));
    const left = leftListing!.key;
    const right = rightListing!.key;
    // Same daily-return model as the CORR pane: price levels of two trending
    // assets correlate spuriously, often with the opposite sign.
    const loadSeries = async (listing: CliListing) => buildCorrelationSeries(
      listing.key,
      await loadForListing(
        listing, services, ctx,
        () => loadCorrelationHistory(services.dataProvider, listing.request.symbol, listing.request.exchange, "1Y"),
      ),
    );
    const [leftSeries, rightSeries] = await Promise.all([loadSeries(leftListing!), loadSeries(rightListing!)]);
    const { correlation, sampleSize } = correlateDailyCloses(leftSeries.prices, rightSeries.prices);
    // A bare symbol names no exchange; its quote says where it lists, which sets when its daily close is taken.
    const [leftQuote, rightQuote] = await Promise.all([leftListing!, rightListing!].map((listing) => loadListingQuote(services.dataProvider, listing)));
    const sessionNote = mixedSessionCloseNote(
      { symbol: leftListing!.symbol, exchange: listingIdentity(leftListing!, leftQuote).exchange, label: left },
      { symbol: rightListing!.symbol, exchange: listingIdentity(rightListing!, rightQuote).exchange, label: right },
      alignDailyCloses(leftSeries.prices, rightSeries.prices).at(-1)?.dateKey,
    );
    // The daily closes used, dated by the newest last bar as the CORR report is.
    const lastBars = [leftSeries, rightSeries].map((series) => series.prices.at(-1)?.dateKey);
    const freshness = rowsFreshness([], {
      ...DAILY_CLOSES,
      asOf: newestReportTime(lastBars),
      oldest: oldestReportTime(lastBars),
    });
    const warnings = [...listingReadNotes(leftListing!), ...listingReadNotes(rightListing!), ...sessionNote ? [sessionNote] : []];
    ctx.printResult({
      data: [{ left, right, samples: sampleSize, correlation }],
      ...(warnings.length > 0 ? { warnings } : {}),
      metadata: { range: "1Y", basis: CORRELATION_RETURN_BASIS },
      freshness,
    }, {
      layout: "record",
      textColumns: [
        { key: "left", header: "Symbols", value: (row) => `${row.left} / ${row.right}` },
        { key: "correlation", header: "Correlation", format: (value) => typeof value === "number" ? value.toFixed(3) : "n/a" },
        { key: "samples", header: "Daily returns" },
      ],
    });
  });
}

export const overviewCliCommands: CliCommandDef[] = [
  {
    name: "movers",
    description: "Show gainers, losers, most active, or trending stocks",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: [MOVERS_USAGE],
      options: [{
        flags: "--session <basis>",
        description: "Rank gainers and losers by the regular-session move (regular, the default) or by the pre-market or after-hours move from the close (extended)",
      }, {
        flags: "--min-float <shares>",
        description: "Keep the gainers, losers or most active whose float (the one EQS serves) is at least this many shares, such as 10M or 500k; a row with no float is left out",
      }],
      examples: ["movers", "movers losers --limit 10", "movers gainers --session extended", "movers gainers --min-float 10M", "movers trending"],
    },
    execute: runMoverCommand,
  },
  {
    name: "indices",
    description: "Show the major US stock indices",
    help: { group: CLI_COMMAND_GROUPS.markets, usage: ["indices"] },
    execute: (args, ctx) => {
      rejectArgs(args, "indices", ctx);
      return runQuoteBasket([...MARKET_SUMMARY_SYMBOLS], ctx, { group: "indices" });
    },
  },
  {
    name: "sectors",
    description: "Show the SPDR sector ETFs",
    help: { group: CLI_COMMAND_GROUPS.markets, usage: ["sectors"] },
    execute: (args, ctx) => {
      rejectArgs(args, "sectors", ctx);
      return runQuoteBasket(getSectorCollection("sectors").items.map((item) => item.etf), ctx, { group: "sectors" });
    },
  },
  {
    name: "econ",
    description: "List upcoming economic calendar events",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: [ECON_USAGE],
      options: [
        { flags: "--country <regions or countries>", description: "US, G7, EU, all (default), or countries by their two-letter codes, comma separated, such as MX or MX,BR,ZA" },
        { flags: "--impact <level>", description: "high, medium, low, or all (default all)" },
        { flags: "--search <words>", description: "Events whose name has these words, case, spaces and hyphens aside, such as nonfarm or fed funds" },
        { flags: "--from <date>", description: `First day listed, as ${DATE_OPTION_EXAMPLES} (default today, UTC); an earlier day lists past events from the stored calendar and says where it starts` },
        { flags: "--tz <zone>", description: "Add a column with each release's time on that clock, an IANA zone such as America/New_York; with the weekday when it falls on another day than the UTC date" },
      ],
      examples: ["econ", "econ --country US --impact high", "econ --search nonfarm", "econ --country MX,BR,ZA,IN,KR", "econ --from 2026-10-12 --country US",
        "econ --country BR --tz America/New_York", "econ --tail 20"],
    },
    execute: runEcon,
  },
  {
    name: "fred",
    description: "Fetch a FRED economic series, or list the ones served",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: [FRED_USAGE, "fred", FRED_LIST_USAGE],
      options: [
        START_OPTION,
        { flags: "--sort <order>", description: "desc for newest first (default) or asc" },
        { flags: "--list", description: "List the series Gloom Cloud serves (ID, title, group), as fred alone does; words after it filter the list" },
        {
          flags: "--change <1D|1W>",
          description: "Add each observation's change in the series' unit (bp for a spread, pp for a percent): 1D from the previous observation, 1W from the last one a week before; holidays stay blank",
        },
      ],
      sections: [{
        title: "Series",
        lines: [
          "Gloom Cloud serves a curated set of FRED series and needs no sign-in for them. gloom fred (or fred --list) prints them by topic; any other ID fails with that pointer.",
        ],
      }],
      examples: ["fred CPIAUCSL", "fred DGS10 --tail 5", "fred DGS10 --change 1D --tail 5", "fred UNRATE --start 2020-01-01 --csv", "fred", "fred --list credit", "fred --list fx"],
    },
    execute: runFred,
  },
  {
    name: "yield-curve",
    description: "Show the latest 3M, 2Y, 10Y, and 30Y Treasury yields",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["yield-curve [--start <date>]"],
      options: [START_OPTION],
    },
    execute: runYieldCurve,
  },
  {
    name: "correlation",
    aliases: ["relationship"],
    description: "Correlate two symbols' daily returns over the past year",
    help: {
      group: CLI_COMMAND_GROUPS.research,
      usage: ["correlation <symbol-a> <symbol-b>"],
      options: [EXCHANGE_OPTION],
      examples: ["correlation AAPL MSFT", "correlation GLD TLT", "correlation BHP:ASX RIO:ASX"],
    },
    execute: runCorrelation,
  },
];
