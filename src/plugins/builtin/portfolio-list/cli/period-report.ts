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
import { loadPeriodPnl, periodBasisText, periodBoughtText, periodCurrencyParts, periodFxLabel, periodSharedDay, periodUnpricedText, type LoadedPeriodPnl } from "../period-pnl";

const signedPercent = (value: number | null) => value == null || !Number.isFinite(value) ? "—"
  : `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toFixed(2)}%`;

/** `Fri 23 Oct`, with the year when it is not this one. */
const dayText = (day: string, year: number) => periodDayText(day, year);
/**
 * The columns `--csv` gained after its own were set, written after
 * `retrieved_at` so none it had moves: what a row is (holding, fx, subtotal,
 * total), its P&L with FX, and whether it counts every holding and why not.
 */
const PERIOD_APPENDED_KEYS = ["rowType", "total", "status", "reason"] as const;

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
  // The book by currency, once it holds more than its own: an FX line each, and each one's local, FX and total.
  const parts = periodCurrencyParts(result);
  const unpricedText = periodUnpricedText(result, label);
  const boughtText = periodBoughtText(result, label);
  const reasons = new Map(result.unpricedReasons.map(({ symbol, reason }) => [symbol, reason]));
  /** A total over holdings some of which have no P&L says which it leaves out. */
  const leftOut = (symbols: readonly string[]) => symbols.length
    ? { status: "partial", reason: `leaves out ${symbols.map((symbol) => `${label(symbol)} (${reasons.get(symbol) ?? "no P&L"})`).join(", ")}` }
    : { status: "complete", reason: null };

  if (structured) {
    const data = result.rows.map((row) => {
      const ticker = bySymbol.get(row.symbol);
      const counted = row.pnl != null && Number.isFinite(row.pnl) && row.fx != null && Number.isFinite(row.fx);
      return {
        symbol: row.symbol, listing: label(row.symbol), shares: shares(row.symbol), priceUnits: Number.isFinite(row.priceUnits) ? row.priceUnits : null,
        ...(ticker && isFuturesTicker(ticker) ? { contractSize: futures.get(row.symbol)?.size?.size ?? null } : {}),
        currency: row.currency, startDay: row.start?.day ?? null, startPrice: row.start?.price ?? null,
        endDay: row.end?.day ?? null, endPrice: row.end?.price ?? null, endPartial: row.partialEnd,
        changePercent: row.changePercent, startValue: row.startValue, pnl: row.pnl, fx: row.fx,
        fxCurrency: row.rates?.currency ?? null, fxStart: row.rates?.start ?? null, fxEnd: row.rates?.end ?? null,
        ...(row.rates && row.end && result.latestFx.includes(`${row.rates.currency}|${row.end.day}`) ? { fxEndLatest: true } : {}),
        contribution: row.contribution, baseCurrency: currency,
        // The columns added since, after the export's own (`PERIOD_APPENDED_KEYS`): what the row is, its P&L with FX, and
        // for a holding with no P&L why, which the totals leave it out for.
        rowType: "holding", total: counted ? row.pnl! + row.fx! : null,
        status: counted ? "counted" : "left out", reason: counted ? null : reasons.get(row.symbol) ?? "no P&L",
      };
    });
    // Each currency's FX line (its pnl the move, as the one FX line's was, and in fx), then each currency's part of the
    // book when the text prints the table of them, then the book's total, each saying when it leaves a holding out.
    // A part's pnl is its price P&L, as a holding's is; total adds its FX. Summing the holding rows gives the price P&L.
    const extraRows: Record<string, unknown>[] = [
      ...parts.filter((part) => !part.own).map((part) => ({ symbol: "FX", currency: part.currency, pnl: part.fx, fx: part.fx, fxCurrency: part.currency,
        contribution: part.fxContribution, baseCurrency: currency, rowType: "fx", total: part.fx, ...leftOut(part.unpriced) })),
      ...(parts.length > 1 ? parts : []).map((part) => ({ symbol: "SUBTOTAL", currency: part.currency, pnl: part.local, fx: part.fx,
        contribution: part.contribution, baseCurrency: currency, rowType: "subtotal", total: part.total, ...leftOut(part.unpriced) })),
      { symbol: "TOTAL", pnl: result.total, fx: result.fx, contribution: result.totalContribution, baseCurrency: currency,
        rowType: "total", total: result.total, ...leftOut(result.unpriced) },
    ];
    const notes = [unpricedText, boughtText].filter((note): note is string => !!note);
    ctx.printResult({ data, metadata: {
      portfolioId: portfolio.id, portfolioName: name, baseCurrency: currency, from: window.from, to: window.to,
      startDay, endDay, basis: basisText, fx: result.fx, fxContribution: result.fxContribution, total: result.total, totalContribution: result.totalContribution,
      totalStatus: leftOut(result.unpriced).status,
      currencies: (result.currencies ?? []).map((part) => ({ ...part, ...leftOut(part.unpriced) })),
      contributionBase: result.contributionBase, contributionBasis: result.contributionBasis,
      complete: result.unpriced.length === 0, unpricedSymbols: result.unpriced, unpriced: result.unpricedReasons, failures: result.failures,
      ...(notes.length ? { notes } : {}),
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
    }, freshness }, { rows: (rows) => [...(rows as Record<string, unknown>[]), ...extraRows], exportNotes: notes, exportAppendedKeys: PERIOD_APPENDED_KEYS });
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
  const percent = (value: number | null) => value == null || !Number.isFinite(value) ? "—" : colorBySign(signedPercent(value), value);
  // An FX line per currency, so the rows add up to the total and each currency's move reads on its own.
  for (const part of parts) if (!part.own) rows.push([periodFxLabel(part.currency), ...blank(lead - 1), money(part.fx), percent(part.fxContribution)]);
  rows.push([cliStyles.bold("TOTAL"), ...blank(lead - 1), cliStyles.bold(money(result.total)), percent(result.totalContribution)]);

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
    { header: `P&L (${currency})`, align: "right" },
    { header: "Contribution", align: "right" },
  ], rows));
  if (parts.length > 1) {
    // What each currency's holdings made from their prices, from the currency, and together, and the book's; one
    // currency's would repeat the total.
    // A figure that leaves a holding out names it, as fn PF's Left out does; a currency with none counted reads —.
    const leftOutCell = (symbols: readonly string[]) => symbols.length ? symbols.map(label).join(", ") : "—";
    const anyLeftOut = result.unpriced.length > 0;
    console.log("");
    console.log(renderTable([
      { header: "Currency" },
      { header: `Local (${currency})`, align: "right" },
      { header: `FX (${currency})`, align: "right" },
      { header: `Total (${currency})`, align: "right" },
      { header: "Contribution", align: "right" },
      ...anyLeftOut ? [{ header: "Left out" }] : [],
    ], [
      ...parts.map((part) => [part.currency, money(part.local), part.own ? "—" : money(part.fx), money(part.total), percent(part.contribution),
        ...anyLeftOut ? [leftOutCell(part.unpriced)] : []]),
      [cliStyles.bold("TOTAL"), money(result.total - result.fx), money(result.fx), cliStyles.bold(money(result.total)), percent(result.totalContribution),
        ...anyLeftOut ? [leftOutCell(result.unpriced)] : []],
    ]));
  }
  console.log("");
  const notes: string[] = [];
  // As markets quote the pair, as `portfolio show` writes its FX line: USD/HKD 7.7531 on Fri 23 Oct, 7.7502 on Fri 30 Oct.
  const rateText = (row: PeriodPnlRow) => {
    const start = quotedFxPair(row.rates!.currency, currency, row.rates!.start);
    const end = quotedFxPair(row.rates!.currency, currency, row.rates!.end);
    // The FX trading day in progress has no close yet: its end is the latest rate, as the live book converts.
    const latest = result.latestFx.includes(`${row.rates!.currency}|${row.end!.day}`);
    return `${start.pair} ${formatFxRate(start.rate)} on ${dayText(row.start!.day, year)}, ${formatFxRate(end.rate)} ${latest ? "latest" : `on ${dayText(row.end!.day, year)}`}`;
  };
  if (fxRows.length) notes.push(`FX: ${[...new Set(fxRows.map(rateText))].join("; ")}. P&L converts at the end's rate; ${parts.filter((part) => !part.own).length > 1 ? "each FX line is its currency's move" : "the FX line is the currency's move"} on the start value.`);
  if (contributionNote) notes.push(contributionNote);
  if (realNote) notes.push(realNote);
  if (unpricedText) notes.push(cliStyles.warning(unpricedText));
  if (boughtText) notes.push(boughtText);
  for (const note of [...new Set(notes)]) console.log(note.startsWith("\u001b") ? note : cliStyles.muted(note));
  console.log(`\n${cliFreshnessFooter(freshness)}`);
  if (explain) console.log(`\n${renderReportGlossary("This report", explained)}`);
}
