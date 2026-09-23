import { apiClient } from "../../api-client";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices } from "../context";
import { formatCompact } from "../../utils/format";
import {
  fetchScreener,
  fetchTrending,
  MARKET_SUMMARY_SYMBOLS,
  rankScreenerQuotes,
  type ScreenerCategory,
} from "../../plugins/builtin/market-movers/screener";
import { formatMoverPrice } from "../../plugins/builtin/market-movers/model";
import { loadCalendar, matchesCountry, matchesImpact, type CountryFilter, type ImpactFilter } from "../../plugins/builtin/econ/calendar-model";
import { isoDate, requireArg, takeOption } from "./command-utils";
import { buildCorrelationSeries } from "../../plugins/builtin/correlation/matrix/model";
import { correlateDailyCloses } from "../../plugins/builtin/correlation/compute";
import { CORRELATION_RETURN_BASIS, loadCorrelationHistory } from "../../plugins/builtin/correlation/history";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { CLI_COMMAND_GROUPS } from "../help";
import { formatChangePercentCell, formatCompactCell } from "../helpers";
import { WORLD_INDICES } from "../../plugins/builtin/world-indices/indices";
import { SECTOR_COLLECTIONS } from "../../plugins/builtin/sectors/sector-data";

const SECTOR_ETFS = [
  "XLC", "XLY", "XLP", "XLE", "XLF", "XLV", "XLI", "XLK", "XLB", "XLRE", "XLU",
];
// Batch quotes often omit names for indices and ETFs; these baskets are fixed, so name them here.
const BASKET_NAMES = new Map<string, string>([
  ...WORLD_INDICES.map((entry) => [entry.symbol, entry.name] as const),
  ...SECTOR_COLLECTIONS.flatMap((collection) => collection.items.map((item) => [item.etf, item.name] as const)),
]);
// Priced like the MOST pane. Index and yield levels (^GSPC, ^TNX) carry no currency sign.
const PRICE_COLUMN = { key: "price", header: "Last", align: "right" as const,
  format: (value: unknown, row: Record<string, unknown>) => typeof value === "number"
    ? formatMoverPrice(value, typeof row.currency === "string" && !String(row.symbol ?? "").startsWith("^") ? row.currency : "") : "" };
const MOVER_COLUMNS = [
  { key: "symbol", header: "Symbol" },
  { key: "name", header: "Name" },
  PRICE_COLUMN,
  { key: "changePercent", header: "Chg%", align: "right" as const, format: formatChangePercentCell },
  { key: "volume", header: "Volume", align: "right" as const, format: formatCompactCell },
  { key: "marketCap", header: "Mkt Cap", align: "right" as const, format: formatCompactCell },
];
const START_OPTION = { flags: "--start <yyyy-mm-dd>", description: "First observation date (default 2021-01-01)" };

function screenerCategory(value: string | undefined): ScreenerCategory | "trending" {
  if (value === "losers") return "day_losers";
  if (value === "active" || value === "most-active") return "most_actives";
  if (value === "trending") return "trending";
  return "day_gainers";
}

function quoteRows(results: Awaited<ReturnType<NonNullable<import("../../types/data-provider").AssetDataProvider["getQuotesBatch"]>>>) {
  return results.map((result) => {
    const quote = result.quote;
    return {
      symbol: result.target.symbol,
      name: quote?.name || BASKET_NAMES.get(result.target.symbol) || "",
      price: quote?.price ?? null,
      change: quote?.change ?? null,
      changePercent: quote?.changePercent == null ? null : Number(quote.changePercent.toFixed(2)),
      currency: quote?.currency ?? "",
      providerId: quote?.providerId ?? "",
      marketCap: quote?.marketCap ?? null,
    };
  });
}

async function runMoverCommand(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const category = screenerCategory(args[0]);
  const limit = ctx.cliOptions.limit ?? 25;
  if (category === "trending") {
    await withCliServices(ctx, async (services) => {
      const trending = await fetchTrending(limit, undefined, { forceRefresh: ctx.cliOptions.refresh });
      const results = await services.dataProvider.getQuotesBatch(
        trending.map(({ symbol }) => ({ symbol, exchange: "" })),
        { forceRefresh: ctx.cliOptions.refresh },
      );
      ctx.printResult({ data: quoteRows(results), metadata: { category } }, {
        textColumns: MOVER_COLUMNS.filter((column) => column.key !== "volume"),
      });
    });
    return;
  }

  const rows = rankScreenerQuotes(
    category,
    await fetchScreener(category, limit, undefined, { forceRefresh: ctx.cliOptions.refresh }),
  );
  ctx.printResult({ data: rows }, {
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
    ctx.printResult({ data: quoteRows(results), metadata }, {
      columns: [
        { key: "symbol", header: "Symbol" },
        { key: "name", header: "Name" },
        PRICE_COLUMN,
        { key: "changePercent", header: "Chg%", align: "right", format: formatChangePercentCell },
        { key: "marketCap", header: "Mkt Cap", align: "right", value: (row) => row.marketCap == null ? "" : formatCompact(Number(row.marketCap)) },
      ],
    });
  });
}

function localDateTimePart(value: unknown, part: "date" | "time"): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return part === "date"
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function runEcon(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const rawArgs = [...args];
  const country = (takeOption(rawArgs, "--country") ?? "all") as CountryFilter;
  const impact = (takeOption(rawArgs, "--impact") ?? "all") as ImpactFilter;
  await withCliServices(ctx, async (services) => {
    const { data: events } = await loadCalendar(ctx.cliOptions.refresh);
    const rows = events
      .filter((event) => matchesCountry(event, country) && matchesImpact(event, impact))
      .sort((left, right) => left.date.getTime() - right.date.getTime())
      .slice(0, ctx.cliOptions.limit ?? 50)
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
    ctx.printResult({ data: rows, metadata: { country, impact } }, {
      columns: [
        // Text shows both halves of the event timestamp in local time; exports keep the source values.
        { key: "date", header: "Date", format: (value) => localDateTimePart(value, "date") },
        { key: "time", header: "Time", format: (_value, row) => localDateTimePart(row.date, "time") },
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

async function runFred(rawArgs: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const args = [...rawArgs];
  const startDate = takeOption(args, "--start") ?? "2021-01-01";
  const sortOrder = (takeOption(args, "--sort") ?? "desc") as "asc" | "desc";
  const seriesId = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb fred <series-id> [--start <yyyy-mm-dd>]", ctx);
  const data = await apiClient.getCloudFredSeries(seriesId, { startDate, sortOrder });
  const rows = data.observations.slice(0, ctx.cliOptions.limit ?? data.observations.length);
  ctx.printResult({ data: rows, metadata: { info: data.info, seriesId, startDate, sortOrder } }, {
    textColumns: [
      { key: "date", header: "Date" },
      { key: "value", header: data.info?.units ? `Value (${data.info.units})` : "Value", align: "right" },
    ],
  });
}

const YIELD_TENORS: Record<string, string> = { DGS3MO: "3M", DGS2: "2Y", DGS10: "10Y", DGS30: "30Y" };

async function runYieldCurve(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const startDate = takeOption(args, "--start") ?? "2021-01-01";
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
  ctx.printResult({ data: results, metadata: { startDate } }, {
    textColumns: [
      { key: "tenor", header: "Tenor", value: (row) => YIELD_TENORS[String(row.seriesId)] ?? row.seriesId },
      { key: "value", header: "Yield %", align: "right" },
      { key: "date", header: "Date" },
      { key: "seriesId", header: "Series" },
    ],
  });
}

async function runCorrelation(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const left = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb correlation <symbol-a> <symbol-b>", ctx);
  const right = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb correlation <symbol-a> <symbol-b>", ctx);
  await withCliServices(ctx, async (services) => {
    // Same daily-return model as the CORR pane: price levels of two trending
    // assets correlate spuriously, often with the opposite sign.
    const loadSeries = async (key: string) => {
      const parsed = parsePublicTickerKey(key);
      const exchange = parsed.exchange ?? (await services.store.loadTicker(key))?.metadata.exchange ?? "";
      return buildCorrelationSeries(key, await loadCorrelationHistory(services.dataProvider, parsed.symbol, exchange, "1Y"));
    };
    const [leftSeries, rightSeries] = await Promise.all([loadSeries(left), loadSeries(right)]);
    const { correlation, sampleSize } = correlateDailyCloses(leftSeries.prices, rightSeries.prices);
    ctx.printResult({ data: [{ left, right, samples: sampleSize, correlation }], metadata: { range: "1Y", basis: CORRELATION_RETURN_BASIS } }, {
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
      usage: ["movers [gainers|losers|active|trending]"],
      examples: ["movers", "movers losers --limit 10", "movers trending"],
    },
    execute: runMoverCommand,
  },
  {
    name: "indices",
    description: "Show the major US stock indices",
    help: { group: CLI_COMMAND_GROUPS.markets, usage: ["indices"] },
    execute: (_args, ctx) => runQuoteBasket([...MARKET_SUMMARY_SYMBOLS], ctx, { group: "indices" }),
  },
  {
    name: "sectors",
    description: "Show the SPDR sector ETFs",
    help: { group: CLI_COMMAND_GROUPS.markets, usage: ["sectors"] },
    execute: (_args, ctx) => runQuoteBasket(SECTOR_ETFS, ctx, { group: "sectors" }),
  },
  {
    name: "econ",
    description: "List upcoming economic calendar events",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["econ [--country <region>] [--impact <level>]"],
      options: [
        { flags: "--country <region>", description: "US, G7, EU, or all (default all)" },
        { flags: "--impact <level>", description: "high, medium, low, or all (default all)" },
      ],
      examples: ["econ", "econ --country US --impact high"],
    },
    execute: runEcon,
  },
  {
    name: "fred",
    description: "Fetch a FRED economic series (needs a Gloom Cloud sign-in)",
    help: {
      group: CLI_COMMAND_GROUPS.markets,
      usage: ["fred <series-id> [--start <yyyy-mm-dd>]"],
      options: [
        START_OPTION,
        { flags: "--sort <order>", description: "desc for newest first (default) or asc" },
      ],
      examples: ["fred CPIAUCSL", "fred UNRATE --start 2020-01-01 --csv"],
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
      examples: ["correlation AAPL MSFT", "correlation GLD TLT"],
    },
    execute: runCorrelation,
  },
];
