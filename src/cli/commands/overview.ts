import { apiClient } from "../../api-client";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices, withConfigData } from "../context";
import { formatCompact } from "../../utils/format";
import { attachFearGreedPersistence, loadFearGreed, resetFearGreedPersistence } from "../../plugins/builtin/fear-greed/cache";
import { createPluginPersistence } from "../../plugins/plugin-persistence";
import {
  fetchScreener,
  fetchTrending,
  MARKET_SUMMARY_SYMBOLS,
  type ScreenerCategory,
} from "../../plugins/builtin/market-movers/screener";
import { loadCalendar, matchesCountry, matchesImpact, type CountryFilter, type ImpactFilter } from "../../plugins/builtin/econ/calendar-model";
import { isoDate, requireArg, takeOption } from "./command-utils";

const SECTOR_ETFS = [
  "XLC", "XLY", "XLP", "XLE", "XLF", "XLV", "XLI", "XLK", "XLB", "XLRE", "XLU",
];

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
      name: quote?.name ?? "",
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
      ctx.printResult({ data: quoteRows(results), metadata: { category } });
    });
    return;
  }

  const rows = await fetchScreener(category, limit, undefined, { forceRefresh: ctx.cliOptions.refresh });
  ctx.printResult({ data: rows }, {
    columns: [
      { key: "symbol", header: "Symbol" },
      { key: "name", header: "Name" },
      { key: "price", header: "Last", align: "right" },
      { key: "changePercent", header: "Chg%", align: "right" },
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
        { key: "price", header: "Last", align: "right" },
        { key: "changePercent", header: "Chg%", align: "right" },
        { key: "marketCap", header: "Mkt Cap", align: "right", value: (row) => row.marketCap == null ? "" : formatCompact(Number(row.marketCap)) },
      ],
    });
  });
}

async function runFearGreed(_args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  await withConfigData(ctx, async (context) => {
    attachFearGreedPersistence(createPluginPersistence(
      context.persistence.pluginState,
      context.persistence.resources,
      "plugin:fear-greed",
      "fear-greed",
    ));
    try {
      const data = await loadFearGreed(ctx.cliOptions.refresh);
      ctx.printResult({
        data: [{
          score: data.overall.score,
          rating: data.overall.rating,
          updatedAt: data.overall.updatedAt?.toISOString() ?? "",
          previousClose: data.overall.previousClose,
          previousWeek: data.overall.previousWeek,
          previousMonth: data.overall.previousMonth,
          previousYear: data.overall.previousYear,
        }],
        metadata: { indicators: data.indicators.map((indicator) => ({ id: indicator.definition.id, score: indicator.score, rating: indicator.rating })) },
      });
    } finally {
      resetFearGreedPersistence();
    }
  });
}

async function runEcon(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const rawArgs = [...args];
  const country = (takeOption(rawArgs, "--country") ?? "all") as CountryFilter;
  const impact = (takeOption(rawArgs, "--impact") ?? "all") as ImpactFilter;
  await withCliServices(ctx, async (services) => {
    const events = await loadCalendar(ctx.cliOptions.refresh);
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
        { key: "date", header: "Date" },
        { key: "time", header: "Time" },
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

async function runFred(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const seriesId = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb fred <series-id>", ctx);
  const startDate = takeOption(args, "--start") ?? "2021-01-01";
  const sortOrder = (takeOption(args, "--sort") ?? "desc") as "asc" | "desc";
  const data = await apiClient.getCloudFredSeries(seriesId, { startDate, sortOrder });
  const rows = data.observations.slice(0, ctx.cliOptions.limit ?? data.observations.length);
  ctx.printResult({ data: rows, metadata: { info: data.info, seriesId, startDate, sortOrder } });
}

async function runYieldCurve(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const startDate = takeOption(args, "--start") ?? "2021-01-01";
  const series = ["DGS3MO", "DGS2", "DGS10", "DGS30"];
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
  ctx.printResult({ data: results, metadata: { startDate } });
}

async function runCorrelation(args: string[], ctx: Parameters<CliCommandDef["execute"]>[1]) {
  const left = requireArg(args[0]?.toUpperCase(), "Usage: gloomberb correlation <symbol-a> <symbol-b>", ctx);
  const right = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb correlation <symbol-a> <symbol-b>", ctx);
  await withCliServices(ctx, async (services) => {
    const [leftHistory, rightHistory] = await Promise.all([
      services.dataProvider.getPriceHistory(left, "", "1Y"),
      services.dataProvider.getPriceHistory(right, "", "1Y"),
    ]);
    const rightByDate = new Map(rightHistory.map((point) => [isoDate(point.date).slice(0, 10), point.close]));
    const pairs = leftHistory
      .map((point) => [point.close, rightByDate.get(isoDate(point.date).slice(0, 10))] as const)
      .filter((pair): pair is readonly [number, number] => pair[1] != null);
    const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / Math.max(1, pairs.length);
    const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / Math.max(1, pairs.length);
    const numerator = pairs.reduce((sum, pair) => sum + ((pair[0] - leftMean) * (pair[1] - rightMean)), 0);
    const leftVariance = pairs.reduce((sum, pair) => sum + ((pair[0] - leftMean) ** 2), 0);
    const rightVariance = pairs.reduce((sum, pair) => sum + ((pair[1] - rightMean) ** 2), 0);
    const correlation = leftVariance > 0 && rightVariance > 0
      ? numerator / Math.sqrt(leftVariance * rightVariance)
      : null;
    ctx.printResult({ data: [{ left, right, samples: pairs.length, correlation }] });
  });
}

export const overviewCliCommands: CliCommandDef[] = [
  { name: "movers", description: "Fetch gainers, losers, active, or trending market movers", help: { usage: ["movers [gainers|losers|active|trending]"] }, execute: runMoverCommand },
  { name: "indices", description: "Fetch major US index quotes", execute: (_args, ctx) => runQuoteBasket([...MARKET_SUMMARY_SYMBOLS], ctx, { group: "indices" }) },
  { name: "sectors", description: "Fetch SPDR sector ETF quotes", execute: (_args, ctx) => runQuoteBasket(SECTOR_ETFS, ctx, { group: "sectors" }) },
  { name: "fear-greed", description: "Fetch CNN Fear & Greed gauge data", execute: runFearGreed },
  { name: "econ", description: "Fetch economic calendar events", help: { usage: ["econ [--country US|G7|EU|all] [--impact high|medium|low|all]"] }, execute: runEcon },
  { name: "fred", description: "Fetch a FRED series through the configured cloud session", help: { usage: ["fred <series-id> [--start yyyy-mm-dd]"] }, execute: runFred },
  { name: "yield-curve", description: "Fetch standard Treasury yield FRED series", help: { usage: ["yield-curve [--start yyyy-mm-dd]"] }, execute: runYieldCurve },
  { name: "correlation", description: "Compute 1Y close-price correlation for two symbols", help: { usage: ["correlation <symbol-a> <symbol-b>"] }, execute: runCorrelation },
  { name: "relationship", description: "Alias for correlation", help: { usage: ["relationship <symbol-a> <symbol-b>"] }, execute: runCorrelation },
];
