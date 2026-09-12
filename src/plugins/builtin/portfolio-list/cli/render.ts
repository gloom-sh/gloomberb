import { createBaseConverter } from "../../../../cli/base-converter";
import { withMarketData } from "../../../../cli/scoped-context";
import {
  countCollectionTickers,
  formatSignedCurrency,
  formatSignedPercentRaw,
} from "../../../../cli/helpers";
import {
  cliStyles,
  colorBySign,
  renderSection,
  renderStat,
  renderTable,
} from "../../../../utils/cli-output";
import { formatCompact } from "../../../../utils/format";
import { formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity } from "../../../../market-data/market/format";
import { getPortfolioPositionMetrics, resolveBrokerFallbackMarketValue, resolveBrokerFallbackPnl } from "../position-metrics";
import { exchangeShortName, getActiveQuoteDisplay } from "../../../../market-data/market/status";
import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext } from "../../../../types/plugin";
import type { MarketContext } from "../../../../cli/types";
import type { TickerRecord } from "../../../../types/ticker";

export function renderCollectionOverview(config: AppConfig, tickers: TickerRecord[]): string {
  const blocks: string[] = [];

  blocks.push(renderSection("Portfolios"));
  if (config.portfolios.length === 0) {
    blocks.push(cliStyles.muted("No portfolios configured."));
  } else {
    blocks.push(renderTable(
      [
        { header: "Portfolio" },
        { header: "Currency" },
        { header: "Tickers", align: "right" },
      ],
      config.portfolios.map((portfolio) => [
        portfolio.name,
        portfolio.currency,
        String(countCollectionTickers(tickers, "portfolios", portfolio.id)),
      ]),
    ));
  }

  blocks.push("");
  blocks.push(renderSection("Watchlists"));
  if (config.watchlists.length === 0) {
    blocks.push(cliStyles.muted("No watchlists configured."));
  } else {
    blocks.push(renderTable(
      [
        { header: "Watchlist" },
        { header: "Tickers", align: "right" },
      ],
      config.watchlists.map((watchlist) => [
        watchlist.name,
        String(countCollectionTickers(tickers, "watchlists", watchlist.id)),
      ]),
    ));
  }

  return blocks.join("\n");
}

export async function showCollection(name: string, ctx: CliCommandContext) {
  await withMarketData(ctx, (context) => showCollectionWithMarketData(name, ctx, context));
}

async function showCollectionWithMarketData(
  name: string,
  ctx: CliCommandContext,
  { config, store, dataProvider }: MarketContext,
) {
  const tickers = (await store.loadAllTickers()).sort((left, right) =>
    left.metadata.ticker.localeCompare(right.metadata.ticker)
  );
  const baseCurrency = config.baseCurrency;
  const toBase = createBaseConverter(dataProvider, baseCurrency);

  const normalized = name.trim().toLowerCase();
  const matchedPortfolio = config.portfolios.find((portfolio) =>
    portfolio.id.toLowerCase() === normalized || portfolio.name.toLowerCase() === normalized
  );
  const matchedWatchlist = config.watchlists.find((watchlist) =>
    watchlist.id.toLowerCase() === normalized || watchlist.name.toLowerCase() === normalized
  );

  if (!matchedPortfolio && !matchedWatchlist) {
    ctx.fail(
      `Collection "${name}" was not found.`,
      `Available: ${[...config.portfolios.map((portfolio) => portfolio.name), ...config.watchlists.map((watchlist) => watchlist.name)].join(", ")}`,
    );
  }

  const isPortfolio = !!matchedPortfolio;
  const id = matchedPortfolio?.id ?? matchedWatchlist!.id;
  const displayName = matchedPortfolio?.name ?? matchedWatchlist!.name;
  const currency = matchedPortfolio?.currency ?? baseCurrency;
  const structured = isPortfolio && ctx.cliOptions?.format != null && ctx.cliOptions.format !== "text";
  const filtered = tickers.filter((ticker) =>
    isPortfolio ? ticker.metadata.portfolios.includes(id) : ticker.metadata.watchlists.includes(id)
  );

  if (filtered.length === 0 && !structured) {
    console.log(cliStyles.bold(displayName));
    console.log(cliStyles.muted("No tickers in this collection."));
    return;
  }

  const quotes = new Map<string, Awaited<ReturnType<typeof dataProvider.getQuote>>>();
  await Promise.all(
    filtered.map(async (ticker) => {
      try {
        const quote = await dataProvider.getQuote(ticker.metadata.ticker, ticker.metadata.exchange);
        quotes.set(ticker.metadata.ticker, quote);
      } catch {
        // Ignore partial quote failures so the rest of the table still renders.
      }
    }),
  );

  if (!structured) {
    console.log(cliStyles.bold(displayName + (isPortfolio ? ` (${currency})` : "")));
    console.log(cliStyles.muted(`${filtered.length} ticker${filtered.length === 1 ? "" : "s"}`));
    console.log("");
  }

  if (isPortfolio) {
    let totalPnl = 0;
    const unavailablePnl = new Set<string>();
    const rows: string[][] = [];
    const positionsExport: Record<string, unknown>[] = [];
    const known = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;

    for (const ticker of filtered) {
      const quote = quotes.get(ticker.metadata.ticker);
      const positions = ticker.metadata.positions.filter((position) => position.portfolio === id);
      const activeQuote = getActiveQuoteDisplay(quote);
      const priceText = quote && activeQuote
        ? colorBySign(formatMarketPriceWithCurrency(activeQuote.price, quote.currency, { assetCategory: ticker.metadata.assetCategory }), activeQuote.change)
        : "—";
      const changeText = activeQuote ? colorBySign(formatSignedPercentRaw(activeQuote.changePercent), activeQuote.change) : "—";

      if (positions.length === 0) {
        rows.push([ticker.metadata.ticker, priceText, changeText, "—", "—", "—"]);
        positionsExport.push({ symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange, shares: null, avgCost: null,
          positionCurrency: null, quotePrice: known(activeQuote?.price), quoteCurrency: quote?.currency ?? null,
          costBasis: null, marketValue: null, unrealizedPnl: null, baseCurrency });
        continue;
      }

      for (const position of positions) {
        const quoteCurrency = quote?.currency ?? ticker.metadata.currency ?? baseCurrency;
        const metrics = getPortfolioPositionMetrics({ ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, id, quoteCurrency);
        const positionCurrency = metrics.positionCurrency;
        const costBasisBase = await toBase(metrics.totalCost, positionCurrency);
        const brokerValue = resolveBrokerFallbackMarketValue(metrics);
        const brokerPnl = resolveBrokerFallbackPnl(metrics);
        const currentValueBase = activeQuote
          ? await toBase(metrics.grossPriceUnits * activeQuote.price, quoteCurrency)
          : brokerValue != null ? await toBase(brokerValue, positionCurrency) : null;
        const pnl = activeQuote && currentValueBase != null
          ? (metrics.totalPriceUnits < 0 ? -1 : 1) * (currentValueBase - costBasisBase)
          : brokerPnl != null ? await toBase(brokerPnl, positionCurrency) : null;
        if (pnl != null && Number.isFinite(pnl)) totalPnl += pnl;
        else unavailablePnl.add(ticker.metadata.ticker);
        const direction = metrics.totalPriceUnits < 0 ? -1 : 1;
        positionsExport.push({ symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange,
          shares: metrics.totalShares, avgCost: position.avgCost, positionCurrency,
          quotePrice: known(activeQuote?.price), quoteCurrency, quoteAsOf: quote?.lastUpdated ?? null,
          costBasis: known(direction * costBasisBase), marketValue: currentValueBase == null ? null : known(direction * currentValueBase),
          unrealizedPnl: known(pnl), baseCurrency, dateAcquired: position.dateAcquired ?? null });

        rows.push([
          ticker.metadata.ticker,
          priceText,
          changeText,
          formatMarketQuantity(metrics.totalShares, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier }),
          formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier }),
          pnl == null || !Number.isFinite(pnl) ? "—" : colorBySign(formatSignedCurrency(pnl, baseCurrency), pnl),
        ]);
      }
    }

    const accountingBasis = "Unrealized P&L on current positions; excludes realized trades, distributions and cash flows. This is not account investment return.";
    const manualAccounting = !matchedPortfolio?.brokerId && !matchedPortfolio?.brokerInstanceId
      ? "Manual holdings are snapshots. Reconcile shares and per-share cost after corporate actions using portfolio position set; cash distributions are not credited."
      : null;
    if (structured) {
      ctx.printResult({ data: positionsExport, metadata: {
        portfolioId: id, portfolioName: displayName, baseCurrency,
        totalUnrealizedPnl: unavailablePnl.size > 0 ? null : totalPnl,
        complete: unavailablePnl.size === 0, unavailableSymbols: [...unavailablePnl],
        accountingBasis, ...(manualAccounting ? { manualAccounting } : {}),
      } });
      return;
    }

    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Last", align: "right" },
        { header: "Chg", align: "right" },
        { header: "Shares", align: "right" },
        { header: "Avg Cost", align: "right" },
        { header: "P&L", align: "right" },
      ],
      rows,
    ));
    console.log("");
    console.log(renderStat("Total P&L", unavailablePnl.size > 0 ? "—" : colorBySign(formatSignedCurrency(totalPnl, baseCurrency), totalPnl)));
    if (unavailablePnl.size > 0) console.log(cliStyles.muted(`P&L unavailable for ${[...unavailablePnl].join(", ")}: a quote, broker value or currency conversion is missing.`));
  } else {
    const rows: string[][] = [];
    for (const ticker of filtered) {
      const quote = quotes.get(ticker.metadata.ticker);
      const priceText = quote
        ? colorBySign(formatMarketPriceWithCurrency(quote.price, quote.currency, { assetCategory: ticker.metadata.assetCategory }), quote.change)
        : "—";
      const changeText = quote ? colorBySign(formatSignedPercentRaw(quote.changePercent), quote.change) : "—";
      const marketCapText = quote?.marketCap != null
        ? `${formatCompact(await toBase(quote.marketCap, quote.currency || ticker.metadata.currency || baseCurrency))} ${baseCurrency}`
        : "—";

      rows.push([
        ticker.metadata.ticker,
        exchangeShortName(quote?.exchangeName, quote?.fullExchangeName) || ticker.metadata.exchange || "—",
        priceText,
        changeText,
        marketCapText,
      ]);
    }

    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Exchange" },
        { header: "Last", align: "right" },
        { header: "Chg", align: "right" },
        { header: "Mkt Cap", align: "right" },
      ],
      rows,
    ));
  }

}
