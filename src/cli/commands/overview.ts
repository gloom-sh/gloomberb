import { logFailure } from "../../utils/log-failure";
import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices } from "../context";
import { formatCompact } from "../../utils/format";
import {
  fetchScreenerResult,
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
import { EXTENDED_SESSION_LABELS, getQuoteSessionFields, type ExtendedSession } from "../../market-data/market/status";
import {
  COUNTRY_CYCLE,
  FILTER_CYCLE,
  loadCalendar,
  matchesCountry,
  matchesImpact,
  shortCalendarEnd,
  type CountryFilter,
  type ImpactFilter,
} from "../../plugins/builtin/econ/calendar-model";
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
import { localTimeSuffix, newestReportTime, oldestReportTime } from "../../utils/utc-time";
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
  flags: "--start <yyyy-mm-dd>",
  description: `First observation date; yyyy or yyyy-mm start at the first of that year or month (default ${DEFAULT_FRED_START})`,
};

const MOVER_LISTS: Record<string, ScreenerCategory | "trending"> = {
  gainers: "day_gainers",
  losers: "day_losers",
  active: "most_actives",
  "most-active": "most_actives",
  trending: "trending",
};
const MOVERS_USAGE = "movers [gainers|losers|active|trending] [--session regular|extended]";
/** The most rows the movers list serves in one request. */
const MOVER_REQUEST_CAP = 100;

function moverRankBasis(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): MoverRankBasis {
  if (value == null) return "regular";
  const basis = MOVER_RANK_BASES.find((candidate) => candidate === value.trim().toLowerCase());
  if (!basis) ctx.fail(`Unknown --session "${value}".`, "Use regular or extended.");
  return basis;
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
  const category = screenerCategory(args, ctx);
  const limit = ctx.cliOptions.limit ?? 25;
  if (sessionOption != null && (category === "trending" || category === "most_actives")) {
    ctx.fail("--session ranks Gainers and Losers.", category === "trending"
      ? "Trending keeps its source's order." : "Most active ranks by volume.");
  }
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
  // asked for, so it reads more candidates than it shows.
  const count = category === "most_actives" ? limit : Math.min(MOVER_REQUEST_CAP, Math.max(limit, MOVER_CANDIDATES));
  const screener = await fetchScreenerResult(category, count, undefined, { forceRefresh: ctx.cliOptions.refresh, session: basis });
  // Last and Chg% are the regular session, as `ticker` reads it, and a
  // pre-market or after-hours print is its own column. The list is ranked by
  // the regular session's move (its close's after the close), or with
  // --session extended by the extended print's move from that close.
  const { quotes, rankedBy } = rankMoverQuotes(category, screener.data.map(moverRegularSession), basis);
  const rows = quotes.slice(0, limit).map((quote) => {
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
  // A screener snapshot, as the MOST report reads it: delayed, each row dated by its own last price.
  ctx.printResult({
    data: rows,
    metadata: { category, rankedBy },
    ...(fellBack ? { warnings: ["No pre-market or after-hours prints now, so the list is ranked by the regular-session move."] } : {}),
    freshness: rowsFreshness(rows, { status: "delayed" }, { stale: screener.stale === true }),
  }, {
    heading: `Ranked by ${MOVER_RANKING_LABELS[rankedBy]}`,
    columns: [
      ...MOVER_COLUMNS.slice(0, 4),
      ...EXTENDED_COLUMNS,
      { key: "volume", header: "Volume", align: "right", value: (row) => formatCompact(Number(row.volume)) },
      { ...MARKET_CAP_CELL, value: (row) => row.marketCap == null ? "" : formatCompact(Number(row.marketCap)) },
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

/** The UTC date, or the UTC time with its zone named (and the reader's own beside it), of an event's timestamp. */
function utcDateTimePart(value: unknown, part: "date" | "time"): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const iso = date.toISOString();
  return part === "date" ? iso.slice(0, 10) : `${iso.slice(11, 16)} UTC${localTimeSuffix(date.getTime())}`;
}

const ECON_USAGE = "econ [--country <region>] [--impact <level>] [--from <yyyy-mm-dd>]";
const DAY_MS = 86_400_000;

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
 * A `yyyy-mm-dd` option, checked here; null when it was not given. `expand`
 * reads a shorthand as a full date first, and `form` is how the message names
 * what the option takes.
 */
function parseDateOption(
  value: string | undefined,
  flag: string,
  ctx: Parameters<CliCommandDef["execute"]>[1],
  { expand = (text: string) => text, form = "yyyy-mm-dd" }: { expand?: (text: string) => string; form?: string } = {},
): string | null {
  if (value == null) return null;
  const date = expand(value.trim());
  const time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    ctx.fail(`${flag} takes a date as ${form}, got "${value}".`);
  }
  return date;
}

/** One of a filter's values, matched without regard to case; anything else fails with the list. */
function parseFilter<T extends string>(value: string | undefined, values: readonly T[], label: string, ctx: Parameters<CliCommandDef["execute"]>[1]): T {
  if (value == null) return values[0]!;
  const match = values.find((candidate) => candidate.toLowerCase() === value.trim().toLowerCase());
  if (!match) ctx.fail(`Unknown ${label} "${value}".`, `Use ${values.join(", ")}.`);
  return match;
}

async function runEcon(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const rawArgs = [...args];
  const country: CountryFilter = parseFilter(takeOption(rawArgs, "--country"), COUNTRY_CYCLE, "country", ctx);
  const impact: ImpactFilter = parseFilter(takeOption(rawArgs, "--impact"), FILTER_CYCLE, "impact", ctx);
  const fromOption = parseDateOption(takeOption(rawArgs, "--from"), "--from", ctx);
  rejectArgs(rawArgs, ECON_USAGE, ctx, "Filter with --country and --impact.");
  await withCliServices(ctx, async () => {
    const { data: events, fetchedAt, stale } = await loadCalendar(ctx.cliOptions.refresh);
    const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    // The calendar lists from today (UTC). --from moves the first day; --tail
    // alone keeps the newest events of the whole calendar, the past week's too.
    const from = fromOption ?? (ctx.cliOptions.tail != null ? null : new Date(todayStart).toISOString().slice(0, 10));
    const fromTime = from == null ? Number.NEGATIVE_INFINITY : Date.parse(`${from}T00:00:00Z`);
    const lastEvent = events.reduce<Date | null>((last, event) => (!last || event.date > last ? event.date : last), null);
    const listedThrough = lastEvent ? lastEvent.toISOString().slice(0, 10) : null;
    // A calendar that stops short of a week ahead says so under the table.
    const listedAfter = shortCalendarEnd(events, Math.max(todayStart, fromTime)) ? `No events listed after ${listedThrough}` : null;
    const rows = events
      .filter((event) => event.date.getTime() >= fromTime && matchesCountry(event, country) && matchesImpact(event, impact))
      .sort((left, right) => left.date.getTime() - right.date.getTime())
      .map((event) => ({
        date: isoDate(event.date),
        time: event.time,
        country: event.country,
        impact: event.impact,
        event: event.event,
        actual: event.actual ?? "",
        forecast: event.forecast ?? "",
        prior: event.prior ?? "",
      }));
    ctx.printResult({
      data: rows,
      metadata: { country, impact, from, listedThrough },
      // The calendar as read, not its rows: those are scheduled, mostly ahead.
      freshness: rowsFreshness([], { status: "not-a-feed", basis: "calendar", asOf: fetchedAt }, { stale }),
    }, {
      dateKey: "date",
      defaultLimit: 50,
      empty: econEmptyMessage(from, listedThrough, listedAfter != null),
      ...(listedAfter ? { footnote: listedAfter } : {}),
      columns: [
        // Text shows both halves of the event timestamp in UTC, never the host's zone; exports keep the source values.
        { key: "date", header: "Date", format: (value) => utcDateTimePart(value, "date") },
        { key: "time", header: "Time", format: (value, row) => value === "All Day" ? "All day" : utcDateTimePart(row.date, "time") },
        { key: "country", header: "Country" },
        { key: "impact", header: "Impact" },
        { key: "event", header: "Event" },
        { key: "actual", header: "Actual" },
        { key: "forecast", header: "Forecast" },
        { key: "prior", header: "Prior" },
      ],
    });
  });
}

const FRED_USAGE = "fred <series-id> [--start <yyyy-mm-dd>] [--sort desc|asc] [--change 1D|1W]";
const FRED_LIST_USAGE = "fred --list [filter]";

/** A year or a month stands for the first day of it. */
function startOfPeriod(text: string): string {
  if (/^\d{4}$/.test(text)) return `${text}-01-01`;
  return /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : text;
}

/** `--start`, checked here: Gloom Cloud cannot read anything but yyyy-mm-dd, so yyyy and yyyy-mm are spelled out. */
function parseStartDate(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): string {
  return parseDateOption(value, "--start", ctx, { expand: startOfPeriod, form: "yyyy-mm-dd, yyyy-mm or yyyy" }) ?? DEFAULT_FRED_START;
}

/** Gloom Cloud serves a curated set of FRED series and answers 400 for any other id. */
function isUnsupportedSeries(error: unknown): boolean {
  if (!(error instanceof ApiRequestError) || error.status !== 400) return false;
  const message = typeof error.details?.message === "string" ? error.details.message : error.message;
  return error.details?.code === "unsupported_series" || /^Unsupported FRED series\b/i.test(message);
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
    empty: filter ? `No supported FRED series match "${filter}". Run gloomberb fred --list to see them all.` : "No FRED series are listed.",
  });
}

async function runFred(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const list = takeFlag(args, "--list");
  const start = takeOption(args, "--start");
  const sort = takeOption(args, "--sort");
  const changeGiven = args.some((arg) => arg === "--change" || arg.startsWith("--change="));
  const change = changeGiven ? takeOption(args, "--change") : undefined;
  if (list) {
    if (start != null || sort != null || changeGiven) {
      ctx.fail("--list takes a filter, not --start, --sort or --change.", `Usage: gloomberb ${FRED_LIST_USAGE}`);
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
  // A change needs the observation it is measured from: the fetch reaches back before the first row shown.
  const fetchStart = horizon ? fredChangeFetchStart(startDate) : startDate;
  const data = await apiClient.getCloudFredSeries(seriesId, { startDate: fetchStart, sortOrder }).catch((error: unknown) => {
    if (isUnsupportedSeries(error)) ctx.fail(`Unsupported FRED series ${seriesId}. List supported series with: gloomberb fred --list`);
    throw error;
  });
  // Every observation exports as `value`, a spread in basis points; its unit goes in the `currency_or_unit` column.
  const unit = fredUnit(seriesId, data.info);
  const interval = fredInterval(data.info?.frequency);
  const mismatch = horizon ? fredChangeMismatch(seriesId, interval, horizon) : null;
  if (mismatch) ctx.fail(mismatch);
  // Each row's change in the unit its value exports in, and the date it is from; a holiday's stays blank.
  const changes = horizon ? fredChanges(seriesId, data.observations, horizon) : null;
  // A value FRED does not list yet carries its publisher and when it published, in every export.
  const exportRow = (observation: { date: string; value: number | null; publisher?: string; publishedAt?: string }) => ({
    date: observation.date,
    value: fredExportValue(seriesId, observation.value),
    ...(changes ? { change: changes.get(observation.date)?.change ?? null, changeFrom: changes.get(observation.date)?.changeFrom ?? null } : {}),
    ...(observation.publisher?.trim() ? { publisher: observation.publisher.trim(), ...(observation.publishedAt ? { publishedAt: observation.publishedAt } : {}) } : {}),
  });
  // A --start before the series begins comes back padded with blank days: the rows start at its first observation.
  const rows = fredObservationsFromStart(data.observations, data.info?.observationStart)
    .filter((observation) => !horizon || observation.date >= startDate)
    .map(exportRow);
  // The default start hides older history and a start before the series begins is moved up silently: say where it really starts.
  const notes = [
    ...fredHistoryNotes({ startDate, startGiven: start != null, seriesStart: data.info?.observationStart }),
    laggingSeriesNote(seriesId),
  ].filter((note): note is string => note != null);
  // Nothing on or after the start: name where the series ends, so an empty answer is not a dead end.
  const latest = rows.length > 0 ? null : await apiClient.getCloudFredSeries(seriesId, { limit: 1, sortOrder: "desc" })
    .then((payload) => payload.observations[0] ?? null).catch(logFailure("cli.commands-overview", "Read latest economic series observation failed", null));
  // CSV and NDJSON are rows alone: an empty one would read as a series with no data, so it fails and says where the series ends.
  if (rows.length === 0 && (ctx.cliOptions.format === "csv" || ctx.cliOptions.format === "ndjson")) {
    ctx.fail(`No ${seriesId} observations on or after ${startDate}.`, fredEmptyAdvice(seriesId, latest));
  }
  const periodicity = periodicityOf(data.info?.frequency);
  const newestDate = rows.reduce<string | null>((newest, row) => (!newest || row.date > newest ? row.date : newest), null);
  // A newest value FRED does not list yet names its publisher, Treasury for a yield; FRED's own stay "FRED".
  const ahead = fredProvenance(data.observations.filter((observation) => observation.date === newestDate));
  // FRED names the series' publisher when Gloom Cloud passes it on, and when it last updated the series.
  const publisher = ahead?.publisher ?? data.info?.source?.trim();
  const publishedAt = ahead ? ahead.publishedAt : fredPublicationTime(data.info, newestDate);
  ctx.printResult({
    data: rows,
    metadata: {
      info: data.info, seriesId, startDate, sortOrder, unit, interval,
      ...(horizon ? { change: horizon } : {}),
      ...(notes.length ? { notes } : {}),
      ...(latest ? { latestObservation: exportRow(latest) } : {}),
    },
    freshness: rowsFreshness(rows, {
      source: ahead?.source ?? "FRED", status: "not-a-feed", basis: "published statistics", observedKey: "date", oldest: null,
      // A monthly or quarterly observation is dated the first of its period, not a day it was seen.
      ...(periodicity ? { periodicity } : {}),
      ...(publisher ? { publisher } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }),
  }, {
    dateKey: "date",
    empty: fredEmptyMessage(startDate, latest == null ? null : exportRow(latest)),
    ...(notes.length ? { footnote: notes.join("\n"), exportNotes: notes } : {}),
    exportIdentity: { symbolOrSeries: seriesId, currencyOrUnit: unit, interval },
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

const YIELD_TENORS: Record<string, string> = { DGS3MO: "3M", DGS2: "2Y", DGS10: "10Y", DGS30: "30Y" };

async function runYieldCurve(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const startDate = parseStartDate(takeOption(args, "--start"), ctx);
  rejectArgs(args, "yield-curve [--start <yyyy-mm-dd>]", ctx);
  const series = Object.keys(YIELD_TENORS);
  const results = await Promise.all(series.map(async (seriesId) => {
    const data = await apiClient.getCloudFredSeries(seriesId, { startDate, sortOrder: "desc" });
    const [latest, previous] = data.observations;
    return {
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
  }));
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
  requireArg(args[0], `Usage: gloomberb ${usage}`, ctx);
  requireArg(args[1], `Usage: gloomberb ${usage}`, ctx);
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
      }],
      examples: ["movers", "movers losers --limit 10", "movers gainers --session extended", "movers trending"],
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
        { flags: "--country <region>", description: "US, G7, EU, or all (default all)" },
        { flags: "--impact <level>", description: "high, medium, low, or all (default all)" },
        { flags: "--from <yyyy-mm-dd>", description: "First day listed (default today, UTC); an earlier day reaches past events" },
      ],
      examples: ["econ", "econ --country US --impact high", "econ --tail 20"],
    },
    execute: runEcon,
  },
  {
    name: "fred",
    description: "Fetch a FRED economic series, or list the ones served",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: [FRED_USAGE, FRED_LIST_USAGE],
      options: [
        START_OPTION,
        { flags: "--sort <order>", description: "desc for newest first (default) or asc" },
        { flags: "--list", description: "List the series Gloom Cloud serves (ID, title, group); words after it filter the list" },
        {
          flags: "--change <1D|1W>",
          description: "Add each observation's change in the series' unit (bp for a spread, pp for a percent): 1D from the previous observation, 1W from the last one a week before; holidays stay blank",
        },
      ],
      sections: [{
        title: "Series",
        lines: [
          "Gloom Cloud serves a curated set of FRED series and needs no sign-in for them. gloomberb fred --list prints them; any other ID fails with that pointer.",
        ],
      }],
      examples: ["fred CPIAUCSL", "fred DGS10 --tail 5", "fred DGS10 --change 1D --tail 5", "fred UNRATE --start 2020-01-01 --csv", "fred --list", "fred --list fx"],
    },
    execute: runFred,
  },
  {
    name: "yield-curve",
    description: "Show the latest 3M, 2Y, 10Y, and 30Y Treasury yields",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["yield-curve [--start <yyyy-mm-dd>]"],
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
