import { apiClient } from "../../api-client";
import { ApiRequestError } from "../../api-client/errors";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices } from "../context";
import { formatCompact } from "../../utils/format";
import {
  fetchScreenerResult,
  fetchTrending,
  MARKET_SUMMARY_SYMBOLS,
  rankScreenerQuotes,
  type ScreenerCategory,
} from "../../plugins/builtin/market-movers/screener";
import { formatMoverPrice, moverReferencePrice } from "../../plugins/builtin/market-movers/model";
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
import { EXCHANGE_OPTION, listingIdentity, loadForListing, loadListingQuote, requireCliListing, type CliListing } from "../listing-arg";
import { CLI_COMMAND_GROUPS } from "../help";
import { formatChangePercentCell, formatCompactCell } from "../helpers";
import { WORLD_INDICES } from "../../plugins/builtin/world-indices/indices";
import { getSectorCollection, SECTOR_COLLECTIONS } from "../../plugins/builtin/sectors/sector-data";
import { DAILY_CLOSES } from "../../plugins/builtin/shared/report-freshness";
import { newestReportTime, oldestReportTime } from "../../utils/utc-time";
import { quotesFreshness, rowsFreshness } from "../freshness";

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
const START_OPTION = { flags: "--start <yyyy-mm-dd>", description: "First observation date (default 2021-01-01)" };

const MOVER_LISTS: Record<string, ScreenerCategory | "trending"> = {
  gainers: "day_gainers",
  losers: "day_losers",
  active: "most_actives",
  "most-active": "most_actives",
  trending: "trending",
};
const MOVERS_USAGE = "movers [gainers|losers|active|trending]";

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

async function runMoverCommand(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const category = screenerCategory(args, ctx);
  const limit = ctx.cliOptions.limit ?? 25;
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

  const screener = await fetchScreenerResult(category, limit, undefined, { forceRefresh: ctx.cliOptions.refresh });
  const rows = rankScreenerQuotes(category, screener.data);
  // A screener snapshot, as the MOST report reads it: delayed, each row dated by its own last price.
  ctx.printResult({ data: rows, freshness: rowsFreshness(rows, { status: "delayed" }, { stale: screener.stale === true }) }, {
    columns: [
      ...MOVER_COLUMNS.slice(0, 4),
      { key: "volume", header: "Volume", align: "right", value: (row) => formatCompact(Number(row.volume)) },
      { key: "marketCap", header: "Mkt Cap", align: "right", value: (row) => row.marketCap == null ? "" : formatCompact(Number(row.marketCap)) },
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

/** The UTC date, or the UTC time with its zone named, of an event's timestamp. */
function utcDateTimePart(value: unknown, part: "date" | "time"): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const iso = date.toISOString();
  return part === "date" ? iso.slice(0, 10) : `${iso.slice(11, 16)} UTC`;
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

/** A `yyyy-mm-dd` option, checked here; null when it was not given. */
function parseDateOption(value: string | undefined, flag: string, ctx: Parameters<CliCommandDef["execute"]>[1]): string | null {
  if (value == null) return null;
  const date = value.trim();
  const time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    ctx.fail(`${flag} takes a date as yyyy-mm-dd, got "${value}".`);
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

const FRED_USAGE = "fred <series-id> [--start <yyyy-mm-dd>] [--sort desc|asc]";
const FRED_LIST_USAGE = "fred --list [filter]";

/** `--start`, checked here: Gloom Cloud cannot read anything but yyyy-mm-dd. */
function parseStartDate(value: string | undefined, ctx: Parameters<CliCommandDef["execute"]>[1]): string {
  return parseDateOption(value, "--start", ctx) ?? "2021-01-01";
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
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = catalog.series
    .map((series) => ({ id: series.id, title: series.title?.trim() ?? "", group: series.group?.trim() ?? "" }))
    .filter((series) => {
      const text = `${series.id} ${series.title} ${series.group}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  ctx.printResult({ data: rows, metadata: { filter: filter || null, total: catalog.series.length } }, {
    columns: [
      { key: "id", header: "ID", shrink: false },
      { key: "title", header: "Title" },
      { key: "group", header: "Group" },
    ],
    empty: filter ? `No supported FRED series match "${filter}". Run gloomberb fred --list to see them all.` : "No FRED series are listed.",
  });
}

async function runFred(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const list = takeFlag(args, "--list");
  const start = takeOption(args, "--start");
  const sort = takeOption(args, "--sort");
  if (list) {
    if (start != null || sort != null) ctx.fail("--list takes a filter, not --start or --sort.", `Usage: gloomberb ${FRED_LIST_USAGE}`);
    return runFredList(args.join(" ").trim(), ctx);
  }
  const startDate = parseStartDate(start, ctx);
  const sortOrder = (sort ?? "desc").trim().toLowerCase();
  if (sortOrder !== "asc" && sortOrder !== "desc") ctx.fail(`Unknown sort order "${sort}".`, "Use desc (newest first) or asc.");
  const seriesId = requireOneArg(args, FRED_USAGE, "series", ctx).toUpperCase();
  const data = await apiClient.getCloudFredSeries(seriesId, { startDate, sortOrder }).catch((error: unknown) => {
    if (isUnsupportedSeries(error)) ctx.fail(`Unsupported FRED series ${seriesId}. List supported series with: gloomberb fred --list`);
    throw error;
  });
  const rows = data.observations;
  ctx.printResult({
    data: rows,
    metadata: { info: data.info, seriesId, startDate, sortOrder },
    freshness: rowsFreshness(rows, { source: "FRED", status: "not-a-feed", basis: "published statistics", observedKey: "date", oldest: null }),
  }, {
    dateKey: "date",
    textColumns: [
      { key: "date", header: "Date" },
      { key: "value", header: data.info?.units ? `Value (${data.info.units})` : "Value", align: "right" },
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
    const latest = data.observations[0];
    return {
      seriesId,
      date: latest?.date ?? "",
      value: latest?.value ?? null,
      title: data.info?.title ?? "",
    };
  }));
  ctx.printResult({
    data: results,
    metadata: { startDate },
    freshness: rowsFreshness(results, { source: "FRED", status: "not-a-feed", basis: "daily Treasury yields", observedKey: "date" }),
  }, {
    textColumns: [
      { key: "tenor", header: "Tenor", value: (row) => YIELD_TENORS[String(row.seriesId)] ?? row.seriesId },
      { key: "value", header: "Yield %", align: "right" },
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
    ctx.printResult({
      data: [{ left, right, samples: sampleSize, correlation }],
      ...(sessionNote ? { warnings: [sessionNote] } : {}),
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
      examples: ["movers", "movers losers --limit 10", "movers trending"],
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
      ],
      sections: [{
        title: "Series",
        lines: [
          "Gloom Cloud serves a curated set of FRED series and needs no sign-in for them. gloomberb fred --list prints them; any other ID fails with that pointer.",
        ],
      }],
      examples: ["fred CPIAUCSL", "fred DGS10 --tail 5", "fred UNRATE --start 2020-01-01 --csv", "fred --list", "fred --list fx"],
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
