import type { ReportFreshness } from "../../../../cli/pane-functions/freshness";
import { cliFreshnessFooter } from "../../../../cli/result";
import { renderReportGlossary, reportGlossary } from "../../../../cli/glossary";
import { formatMarketPriceWithCurrency, formatMarketQuantity, withCurrencyMinorDigits } from "../../../../market-data/market/format";
import { periodDayText } from "../../../../market-data/market/period-return";
import { formatAllocationMoney } from "../../../../portfolio/allocation";
import type { CostFxHistoryClient } from "../../../../portfolio/cost-fx";
import { futuresQuantityText, isFuturesTicker, type PortfolioFuturesTerms } from "../../../../portfolio/futures-positions";
import type { PeriodPnlRow } from "../../../../portfolio/period-pnl";
import type { DataProvider } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";
import { formatFxRate } from "../../../../cli/fx-pair";
import { quotedFxPair } from "../../../../utils/currency-pair";
import type { CliCommandContext } from "../../../../types/plugin";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import { cliStyles, colorBySign, renderTable } from "../../../../utils/cli-output";
import type { PriceWindow } from "../../../../utils/price-window";
import { apiClient } from "../../../../api-client";
import { inflationMethodText, loadPeriodInflation, monthText, realReturn } from "../../../../portfolio/real-return";
import { loadPeriodPnl, periodBasisText, periodBoughtText, periodSharedDay, periodUnpricedText, type LoadedPeriodPnl } from "../period-pnl";

const signedPercent = (value: number | null) => value == null || !Number.isFinite(value) ? "—"
  : `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toFixed(2)}%`;

/** `Fri 23 Oct`, with the year when it is not this one. */
const dayText = (day: string, year: number) => periodDayText(day, year);

/**
 * `portfolio show <name> --from <date> [--to <date>]`: P&L and contribution
 * by position between two closes, then the FX line and the total, in the
 * book's currency. JSON and CSV carry the same rows, the FX line and the
 * total as rows of their own, as `portfolio show` exports its cash and total.
 */
export async function showPeriodPnl({ ctx, portfolio, name, tickers, currency, window, provider, fxHistory, quotes, futures, source, listingLabel, explain = false, real = false, cpi = apiClient }: {
  ctx: CliCommandContext;
  portfolio: Portfolio;
  name: string;
  tickers: readonly TickerRecord[];
  currency: string;
  window: PriceWindow;
  provider: DataProvider;
  fxHistory: CostFxHistoryClient;
  quotes: ReadonlyMap<string, Quote | undefined>;
  futures: ReadonlyMap<string, PortfolioFuturesTerms>;
  source: string;
  /** How `portfolio show` names a row: GC=F:CMX. */
  listingLabel: (ticker: TickerRecord) => string;
  /** `--explain`: follow the report with what its terms mean (Contribution). */
  explain?: boolean;
  /** `--real`: the total's return after the book currency's consumer prices too. */
  real?: boolean;
  /** Where the CPI is read; Gloom Cloud by default. */
  cpi?: Parameters<typeof loadPeriodInflation>[2];
}) {
  const explained = explain ? reportGlossary("PF", "Contribution") : [];
  const structured = ctx.cliOptions?.format != null && ctx.cliOptions.format !== "text";
  const [result, inflation]: [LoadedPeriodPnl, Awaited<ReturnType<typeof loadPeriodInflation>> | null] = await Promise.all([
    loadPeriodPnl({ tickers, portfolioId: portfolio.id, currency, window, provider, fxHistory, quotes, futures, refresh: !!ctx.cliOptions?.refresh }),
    real ? loadPeriodInflation(currency, window, cpi) : null,
  ]);
  // The total's return after consumer prices: (1 + nominal) / (1 + inflation) - 1, on the same book value as Contribution.
  const deflated = inflation && !("error" in inflation) && result.totalContribution != null
    ? { ...inflation, nominal: result.totalContribution / 100, real: realReturn(result.totalContribution / 100, inflation.inflation) }
    : null;
  const realNote = !inflation ? null : "error" in inflation ? cliStyles.warning(`Real return: ${inflation.error}`)
    : deflated && inflation.fromMonth === inflation.toMonth
      ? `Real: ${signedPercent(deflated.real * 100)}, the total itself: no ${inflation.source.label} month after ${monthText(inflation.fromMonth)} is out by the end.`
    : deflated ? `Real: ${signedPercent(deflated.real * 100)} after ${inflation.source.label} ${signedPercent(inflation.inflation * 100)}, ${monthText(inflation.fromMonth)} to ${monthText(inflation.toMonth)}${inflation.latestPublished ? " (the latest published)" : ""}; ${inflationMethodText(inflation)}. (1 + total) / (1 + inflation) - 1.`
      : cliStyles.warning("Real return: the total has no return to deflate.");
  const bySymbol = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker]));
  const label = (symbol: string) => {
    const ticker = bySymbol.get(symbol);
    return ticker ? listingLabel(ticker) : symbol;
  };
  const shares = (symbol: string) => (bySymbol.get(symbol)?.metadata.positions ?? [])
    .filter((position) => position.portfolio === portfolio.id).reduce((sum, position) => sum + position.shares, 0);
  const year = new Date().getUTCFullYear();
  const startDay = periodSharedDay(result.rows, "start");
  const endDay = periodSharedDay(result.rows, "end");
  const futuresHeld = result.rows.some((row) => { const ticker = bySymbol.get(row.symbol); return !!ticker && isFuturesTicker(ticker); });
  const basisText = periodBasisText(result, { futuresHeld });
  const asOf = result.rows.reduce<string | null>((latest, row) => row.end && (!latest || row.end.day > latest) ? row.end.day : latest, null);
  const freshness: ReportFreshness = { source, asOf, status: "not-a-feed", basis: `daily closes, ${window.from} to ${window.to}`, retrievedAt: new Date().toISOString() };
  const contributionNote = result.contributionBase == null ? null
    : `Contribution is P&L over the book's ${result.contributionBasis === "gross" ? "gross exposure" : "value"} at the start, ${formatAllocationMoney(result.contributionBase, currency, { whole: true })}${result.contributionBasis === "gross" ? ", longs plus shorts at their absolute value, as the book holds a short" : ""}; cash excluded.`;
  const fxRows = result.rows.filter((row) => row.rates);
  const fxCurrencies = [...new Set(fxRows.map((row) => row.rates!.currency))].join(", ");

  if (structured) {
    const data = result.rows.map((row) => {
      const ticker = bySymbol.get(row.symbol);
      return {
        symbol: row.symbol, listing: label(row.symbol), shares: shares(row.symbol), priceUnits: Number.isFinite(row.priceUnits) ? row.priceUnits : null,
        ...(ticker && isFuturesTicker(ticker) ? { contractSize: futures.get(row.symbol)?.size?.size ?? null } : {}),
        currency: row.currency, startDay: row.start?.day ?? null, startPrice: row.start?.price ?? null,
        endDay: row.end?.day ?? null, endPrice: row.end?.price ?? null, endPartial: row.partialEnd,
        changePercent: row.changePercent, startValue: row.startValue, pnl: row.pnl, fx: row.fx,
        fxCurrency: row.rates?.currency ?? null, fxStart: row.rates?.start ?? null, fxEnd: row.rates?.end ?? null, contribution: row.contribution, baseCurrency: currency,
      };
    });
    const extraRows: Record<string, unknown>[] = [
      ...(fxRows.length ? [{ symbol: "FX", pnl: result.fx, contribution: result.fxContribution, baseCurrency: currency }] : []),
      { symbol: "TOTAL", pnl: result.total, contribution: result.totalContribution, baseCurrency: currency },
    ];
    ctx.printResult({ data, metadata: {
      portfolioId: portfolio.id, portfolioName: name, baseCurrency: currency, from: window.from, to: window.to,
      startDay, endDay, basis: basisText, fx: result.fx, fxContribution: result.fxContribution, total: result.total, totalContribution: result.totalContribution,
      contributionBase: result.contributionBase, contributionBasis: result.contributionBasis,
      complete: result.unpriced.length === 0, unpricedSymbols: result.unpriced, unpriced: result.unpricedReasons, failures: result.failures,
      boughtInWindowSymbols: result.boughtInWindow, latestPriceAt: result.latestPriceAt == null ? null : new Date(result.latestPriceAt).toISOString(),
      ...(explain ? { glossary: explained.map(({ term, definition }) => ({ term, definition })) } : {}),
      ...(inflation ? { real: "error" in inflation ? { error: inflation.error } : {
        cpi: inflation.source.label, publisher: inflation.source.publisher, method: inflationMethodText(inflation),
        fromMonth: inflation.fromMonth, toMonth: inflation.toMonth, latestPublished: inflation.latestPublished,
        inflationPercent: inflation.inflation * 100, nominalPercent: deflated ? deflated.nominal * 100 : null, realPercent: deflated ? deflated.real * 100 : null,
        // The published values it was read from, as the source gives them: levels, or changes in percent.
        readings: inflation.readings,
      } } : {}),
      method: "Each holding's price move times the units held now (contracts times their size for a future), converted at the end's FX rate; the FX line is each holding's start value times its currency's move. Contribution divides by the book's value at the start, gross when it holds a short.",
    }, freshness }, { rows: (rows) => [...(rows as Record<string, unknown>[]), ...extraRows] });
    return;
  }

  const money = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—"
    : colorBySign(formatAllocationMoney(value, currency, { signed: true }), value);
  // Padded to the currency's minor unit ($80.20, not $80.2), as `portfolio show` prints Last.
  const price = (row: PeriodPnlRow, close: PeriodPnlRow["start"]) => close ? formatMarketPriceWithCurrency(close.price, row.currency,
    withCurrencyMinorDigits({ assetCategory: bySymbol.get(row.symbol)?.metadata.assetCategory }, row.currency)) : "—";
  const quantity = (symbol: string) => {
    const ticker = bySymbol.get(symbol);
    const units = formatMarketQuantity(shares(symbol), { assetCategory: ticker?.metadata.assetCategory });
    return ticker && isFuturesTicker(ticker) ? futuresQuantityText(units, futures.get(symbol)?.size ?? null) : units;
  };
  const dated = !startDay || !endDay;
  const rows = result.rows.map((row) => [
    label(row.symbol), quantity(row.symbol),
    ...dated ? [row.start ? dayText(row.start.day, year) : "—"] : [], price(row, row.start),
    ...dated ? [row.end ? dayText(row.end.day, year) : "—"] : [], price(row, row.end),
    row.changePercent == null ? "—" : colorBySign(signedPercent(row.changePercent), row.changePercent),
    money(row.pnl), row.contribution == null ? "—" : colorBySign(signedPercent(row.contribution), row.contribution),
  ]);
  const blank = (count: number) => Array.from({ length: count }, () => "");
  const lead = 3 + (dated ? 2 : 0) + 2;
  if (fxRows.length) rows.push([`FX (${fxCurrencies})`, ...blank(lead - 1), money(result.fx), colorBySign(signedPercent(result.fxContribution), result.fxContribution ?? 0)]);
  rows.push([cliStyles.bold("TOTAL"), ...blank(lead - 1), cliStyles.bold(money(result.total)),
    result.totalContribution == null ? "—" : colorBySign(signedPercent(result.totalContribution), result.totalContribution)]);

  console.log(cliStyles.bold(`${name} (${currency})`));
  console.log(cliStyles.muted(basisText));
  console.log("");
  console.log(renderTable([
    { header: "Ticker" },
    { header: futuresHeld ? "Qty" : "Shares", align: "right" },
    ...dated ? [{ header: "From", optional: true, dropPriority: 1 }] : [],
    { header: "Start", align: "right", optional: true, dropPriority: 2 },
    ...dated ? [{ header: "To", optional: true, dropPriority: 1 }] : [],
    { header: "End", align: "right", optional: true, dropPriority: 2 },
    { header: "Chg", align: "right", optional: true, dropPriority: 3 },
    { header: "P&L", align: "right" },
    { header: "Contribution", align: "right" },
  ], rows));
  console.log("");
  const notes: string[] = [];
  // As markets quote the pair, as `portfolio show` writes its FX line: USD/HKD 7.7531 on Fri 23 Oct, 7.7502 on Fri 30 Oct.
  const rateText = (row: PeriodPnlRow) => {
    const start = quotedFxPair(row.rates!.currency, currency, row.rates!.start);
    const end = quotedFxPair(row.rates!.currency, currency, row.rates!.end);
    return `${start.pair} ${formatFxRate(start.rate)} on ${dayText(row.start!.day, year)}, ${formatFxRate(end.rate)} on ${dayText(row.end!.day, year)}`;
  };
  if (fxRows.length) notes.push(`FX: ${[...new Set(fxRows.map(rateText))].join("; ")}. P&L converts at the end's rate; the FX line is the currency's move on the start value.`);
  if (contributionNote) notes.push(contributionNote);
  if (realNote) notes.push(realNote);
  const unpricedText = periodUnpricedText(result, label);
  if (unpricedText) notes.push(cliStyles.warning(unpricedText));
  const boughtText = periodBoughtText(result, label);
  if (boughtText) notes.push(boughtText);
  for (const note of [...new Set(notes)]) console.log(note.startsWith("\u001b") ? note : cliStyles.muted(note));
  console.log(`\n${cliFreshnessFooter(freshness)}`);
  if (explain) console.log(`\n${renderReportGlossary("This report", explained)}`);
}
