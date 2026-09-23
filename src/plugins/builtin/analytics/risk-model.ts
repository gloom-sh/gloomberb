import { portfolioOptionGreeks } from "./risk-options";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { formatNumber } from "../../../utils/format";
import type { DatedReturn } from "./metrics";
import {
  computeWeightedPortfolioReturns,
  syntheticPositionUnsupportedReason,
} from "./metrics";
import {
  concentration,
  pairedReturns,
  regressReturns,
  rollingBasketRisk,
  rollingBeta,
  subtractReturns,
} from "./risk-math";
import {
  calculateAccountPerformance,
  calculateBrinson,
  type PortfolioRiskEvidence,
} from "./risk-evidence";
import {
  RISK_FACTOR_INSTRUMENTS,
  riskInstrumentId,
  type RiskMarketSnapshot,
} from "./risk-client";

export interface PortfolioRiskHolding {
  id: string;
  symbol: string;
  exchange: string;
  quantity: number;
  currency: string;
  value: number | null;
  weight: number | null;
  priceAsOf: string | null;
  /** "close" when no current quote arrived and the latest completed close marks the holding. */
  markSource?: "quote" | "close" | null;
  historyAsOf: string | null;
  returns: DatedReturn[];
  error: string | null;
}
export interface RiskDisplayRow {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  percentile: number | null;
  asOf: string | null;
  detail: string;
  history?: Array<{ date: string; value: number | null }>;
  /** Brinson effects in pp, on attribution rows only; `value` is their total. */
  allocation?: number;
  selection?: number;
  interaction?: number;
}
/** Book-level concentration rows that lead the holdings view, ahead of one row per holding. */
export const HOLDINGS_SUMMARY_ROW_IDS: ReadonlySet<string> = new Set(["top", "top-five", "hhi"]);
export const RISK_VIEWS = [
  "risk",
  "factors",
  "holdings",
  "correlation",
  "stress",
  "performance",
  "attribution",
  "greeks",
] as const;
export type RiskView = (typeof RISK_VIEWS)[number];
export interface RiskShifts {
  equity: number;
  rates: number;
  volatility: number;
}
export const DEFAULT_RISK_SHIFTS: RiskShifts = {
  equity: -10,
  rates: 100,
  volatility: 10,
};

function fredChanges(data: RiskMarketSnapshot["yields"]): DatedReturn[] {
  const rows = (data?.observations ?? [])
    .filter((row): row is { date: string; value: number } => row.value != null)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  return rows
    .slice(1)
    .map((row, index) => ({
      startDateKey: rows[index]!.date,
      dateKey: row.date,
      value: row.value - rows[index]!.value,
    }));
}
function quoteDate(value: number | undefined): string | null {
  return Number.isFinite(value) && value! > 0
    ? new Date(value!).toISOString()
    : null;
}
function positions(ticker: TickerRecord, id: string) {
  return ticker.metadata.positions.filter(
    (row) => row.portfolio === id && row.shares !== 0,
  );
}
export function portfolioRiskTickers(
  tickers: readonly TickerRecord[],
  portfolioId: string,
) {
  return tickers.filter(
    (ticker) =>
      ticker.metadata.portfolios.includes(portfolioId) &&
      positions(ticker, portfolioId).length > 0,
  );
}
/** All holding identities stay in the denominator. A missing value/history blocks basket estimates. */
export function buildPortfolioRisk(
  portfolio: Portfolio,
  tickers: readonly TickerRecord[],
  market: RiskMarketSnapshot,
  evidence: PortfolioRiskEvidence | null = null,
  shifts: RiskShifts = DEFAULT_RISK_SHIFTS,
) {
  if (
    ![shifts.equity, shifts.rates, shifts.volatility].every(Number.isFinite) ||
    shifts.equity <= -100 ||
    Math.abs(shifts.equity) > 100 ||
    Math.abs(shifts.rates) > 500 ||
    shifts.volatility < -50 ||
    shifts.volatility > 100
  )
    throw new Error("Stress shifts exceed the supported range");
  if (
    evidence &&
    (evidence.portfolioId !== portfolio.id ||
      evidence.currency !== portfolio.currency)
  )
    throw new Error(
      "Imported evidence belongs to a different portfolio or currency",
    );
  const byId = new Map(
    market.histories.map((row) => [riskInstrumentId(row.instrument), row]),
  );
  const holdings: PortfolioRiskHolding[] = portfolioRiskTickers(
    tickers,
    portfolio.id,
  ).map((ticker) => {
    const instrument = {
        symbol: ticker.metadata.ticker,
        exchange: ticker.metadata.exchange,
      },
      id = riskInstrumentId(instrument);
    const history = byId.get(id),
      quote = history?.quote,
      lots = positions(ticker, portfolio.id);
    // A current quote marks the holding; otherwise its latest completed close does.
    const close = history?.closeMark ?? null;
    const mark = close
      ? { price: close.price, currency: close.currency, stale: false }
      : quote
        ? { price: quote.price, currency: quote.currency, stale: !!quote.stale }
        : null;
    const quantity = lots.reduce(
      (sum, row) =>
        sum + (row.side === "short" ? -Math.abs(row.shares) : row.shares),
      0,
    );
    const error =
      syntheticPositionUnsupportedReason(
        ticker,
        quote?.currency ?? close?.currency ?? ticker.metadata.currency,
        portfolio.id,
      ) ??
      (lots.some((row) => !Number.isFinite(row.shares))
        ? "Invalid position quantity"
        : null) ??
      (portfolio.currency !== "USD"
        ? "Historical account-currency FX is required"
        : null) ??
      (ticker.metadata.currency &&
      mark?.currency &&
      ticker.metadata.currency !== mark.currency
        ? "Holding and quote currencies differ"
        : null) ??
      history?.error ??
      (!history ? "Daily history unavailable" : null);
    const priceDate = close ? close.date : quoteDate(quote?.lastUpdated);
    const value =
      mark &&
      mark.currency === portfolio.currency &&
      !mark.stale &&
      Number.isFinite(mark.price) &&
      mark.price > 0 &&
      priceDate &&
      (!syntheticPositionUnsupportedReason(
        ticker,
        mark.currency,
        portfolio.id,
      ) ||
        error?.startsWith("Short positions"))
        ? quantity * mark.price
        : null;
    return {
      id,
      ...instrument,
      quantity,
      currency: quote?.currency ?? close?.currency ?? ticker.metadata.currency,
      value: Number.isFinite(value) ? value : null,
      weight: null,
      priceAsOf: priceDate,
      markSource: close ? "close" : quote ? "quote" : null,
      historyAsOf: history?.asOf ?? null,
      returns: history?.returns ?? [],
      error,
    };
  });
  const book = concentration(holdings);
  for (const holding of holdings)
    holding.weight =
      book?.rows.find((row) => row.id === holding.id)?.weight ?? null;
  const warnings = [
    ...market.warnings,
    ...market.histories.flatMap((row) =>
      row.error ? [`${row.instrument.symbol}: ${row.error}`] : [],
    ),
    ...holdings.flatMap((row) =>
      row.error ? [`${row.symbol}: ${row.error}`] : [],
    ),
  ];
  const completeBasket =
    holdings.length > 0 &&
    holdings.length <= 80 &&
    book != null &&
    holdings.every(
      (row) =>
        !row.error &&
        row.value != null &&
        row.value > 0 &&
        row.returns.length >= 60,
    );
  if (holdings.length > 80)
    warnings.push("Basket risk supports at most 80 holdings");
  if (!completeBasket && holdings.length)
    warnings.push(
      "Basket estimates require complete, positive USD equity marks and matched daily history for every holding.",
    );
  const basket = completeBasket
    ? computeWeightedPortfolioReturns(
        holdings.map((row) => ({ weight: row.weight!, returns: row.returns })),
      )
    : [];
  const proxy = (symbol: string) => {
    const instrument = RISK_FACTOR_INSTRUMENTS.find(
      (row) => row.symbol === symbol,
    );
    return (instrument && byId.get(riskInstrumentId(instrument))?.returns) || [];
  };
  const benchmark = proxy("SPY"),
    sample = pairedReturns(basket, benchmark);
  const metrics = rollingBasketRisk(sample);
  const factors = [
    { id: "market", label: "Market (SPY)", series: benchmark },
    {
      id: "size",
      label: "Size (IWM - SPY)",
      series: subtractReturns(proxy("IWM"), benchmark),
    },
    {
      id: "value",
      label: "Value (IWD - IWF)",
      series: subtractReturns(proxy("IWD"), proxy("IWF")),
    },
    {
      id: "momentum",
      label: "Momentum (MTUM - SPY)",
      series: subtractReturns(proxy("MTUM"), benchmark),
    },
    { id: "rates", label: "Rates (IEF)", series: proxy("IEF") },
    {
      id: "credit",
      label: "Credit (HYG - IEF)",
      series: subtractReturns(proxy("HYG"), proxy("IEF")),
    },
  ].map((factor) => ({
    ...rollingBeta(basket, factor.series, factor.label, factor.id),
    regression: regressReturns(basket.slice(-60), factor.series),
  }));
  const correlation = holdings.flatMap((left, index) =>
    holdings.slice(index + 1).map((right) => {
      const regression = regressReturns(left.returns.slice(-60), right.returns);
      return {
        left: left.id,
        right: right.id,
        label: `${left.symbol} / ${right.symbol}`,
        ...regression,
        value: regression?.correlation ?? null,
      };
    }),
  );
  const stresses = [
    {
      id: "equity",
      label: `Index ${shifts.equity > 0 ? "+" : ""}${shifts.equity}%`,
      series: benchmark,
      shock: shifts.equity / 100,
      source: "SPY price return",
    },
    {
      id: "rates",
      label: `10Y yield ${shifts.rates > 0 ? "+" : ""}${shifts.rates} bp`,
      series: fredChanges(market.yields),
      shock: shifts.rates / 100,
      source: "DGS10 percentage-point change",
    },
    {
      id: "volatility",
      label: `VIX ${shifts.volatility > 0 ? "+" : ""}${shifts.volatility} points`,
      series: fredChanges(market.volatility),
      shock: shifts.volatility,
      source: "VIXCLS point change",
    },
  ].map((stress) => {
    const regression = regressReturns(basket.slice(-126), stress.series);
    return {
      ...stress,
      regression,
      value: regression ? regression.beta * stress.shock * 100 : null,
    };
  });
  if (completeBasket)
    for (const factor of factors)
      if (factor.samples === 0)
        warnings.push(`${factor.label}: no matched factor history`);
  if (completeBasket && metrics.every((row) => row.value == null))
    warnings.push("Fewer than 60 consecutive matched completed daily returns.");
  const performance = evidence?.performance
    ? calculateAccountPerformance(evidence.performance)
    : null;
  const attribution = evidence?.attribution
    ? calculateBrinson(evidence.attribution)
    : null;
  const optionBook = evidence?.options
    ? { ...evidence.options, complete: true, warnings: [] }
    : market.brokerOptions;
  const greeks = optionBook
    ? portfolioOptionGreeks(
        optionBook,
        portfolio.currency,
        Date.parse(market.fetchedAt),
      )
    : null;
  warnings.push(...(greeks?.warnings ?? []));
  const rows: Record<RiskView, RiskDisplayRow[]> = {
    risk: metrics.map((row) => ({
      ...row,
      percentile: row.rank.percentile,
      detail: `${row.samples} sessions; price returns; fixed current weights`,
    })),
    factors: factors.map((row) => ({
      ...row,
      percentile: row.rank.percentile,
      detail: `${row.samples} sessions; R² ${row.regression?.rSquared?.toFixed(2) ?? "--"}; independent ETF proxy`,
    })),
    // Largest exposure first; holdings without a mark sort last.
    holdings: [...holdings]
      .sort((a, b) => (b.weight ?? -Infinity) - (a.weight ?? -Infinity))
      .map((row) => ({
      id: row.id,
      label: row.symbol,
      value: row.weight == null ? null : row.weight * 100,
      unit: "% gross",
      percentile: null,
      asOf: row.priceAsOf,
      detail:
        row.error ??
        `${row.quantity} shares; ${formatNumber(row.value ?? undefined)} ${row.currency}${row.markSource === "close" ? ` at ${row.priceAsOf} close` : ""}; history ${row.historyAsOf}`,
    })),
    correlation: correlation.map((row) => ({
      id: `${row.left}/${row.right}`,
      label: row.label,
      value: row.value,
      unit: "correlation",
      percentile: null,
      asOf: row.asOf ?? null,
      detail: `${row.samples ?? 0} matched daily returns`,
    })),
    stress: stresses.map((row) => ({
      id: row.id,
      label: row.label,
      value: row.value,
      unit: "%",
      percentile: null,
      asOf: row.regression?.asOf ?? null,
      detail: `${row.regression?.samples ?? 0} sessions; R² ${row.regression?.rSquared?.toFixed(2) ?? "--"}; ${row.source}`,
    })),
    performance: performance
      ? [
          {
            id: "twr",
            label: "TWR",
            value: performance.twr * 100,
            unit: "%",
            detail: "Linked external-flow-adjusted return",
          },
          {
            id: "mwr",
            label: "MWR annualized",
            value: performance.mwr == null ? null : performance.mwr * 100,
            unit: "%",
            detail:
              performance.mwrReason ?? "Dated investor cashflows; actual/365",
          },
          {
            id: "drawdown",
            label: "Account max drawdown",
            value: performance.maxDrawdown * 100,
            unit: "%",
            detail: "Unitized account return",
          },
        ].map((row) => ({
          ...row,
          percentile: null,
          asOf: performance.endDate,
          detail: `${performance.startDate} to ${performance.endDate}; ${row.detail}`,
        }))
      : [],
    attribution: attribution
      ? attribution.rows.map((row) => ({
          id: row.sector,
          label: row.sector,
          value: row.total * 100,
          unit: "pp",
          percentile: null,
          asOf: attribution.endDate,
          detail: `Allocation ${(row.allocation * 100).toFixed(2)}; selection ${(row.selection * 100).toFixed(2)}; interaction ${(row.interaction * 100).toFixed(2)} pp`,
          allocation: row.allocation * 100,
          selection: row.selection * 100,
          interaction: row.interaction * 100,
        }))
      : [],
    greeks: greeks
      ? [
          ...(greeks.total
            ? [
                {
                  symbol: `${greeks.scope} total`,
                  asOf: Math.min(...greeks.rows.map((row) => row.asOf)),
                  ...greeks.total,
                  error: null,
                },
              ]
            : []),
          ...greeks.rows,
        ].flatMap((row, index) =>
          [
            {
              id: `${index}:${row.symbol}:delta`,
              label: `${row.symbol} dollar delta`,
              value: row.deltaDollars,
              unit: portfolio.currency,
            },
            {
              id: `${index}:${row.symbol}:gamma`,
              label: `${row.symbol} gamma P&L 1%`,
              value: row.gammaOnePercent,
              unit: portfolio.currency,
            },
            {
              id: `${index}:${row.symbol}:vega`,
              label: `${row.symbol} vega`,
              value: row.vega,
              unit: `${portfolio.currency}/vol pt`,
            },
            {
              id: `${index}:${row.symbol}:theta`,
              label: `${row.symbol} theta`,
              value: row.theta,
              unit: `${portfolio.currency}/day`,
            },
            {
              id: `${index}:${row.symbol}:rho`,
              label: `${row.symbol} rho`,
              value: row.rho,
              unit: `${portfolio.currency}/rate pt`,
            },
          ].map((metric) => ({
            ...metric,
            percentile: null,
            asOf: new Date(row.asOf).toISOString(),
            detail:
              row.error ?? `${greeks.scope} option book; European OSA model`,
          })),
        )
      : [],
  };
  if (book)
    rows.holdings.unshift(
      {
        id: "top",
        label: "Largest holding",
        value: book.top * 100,
        unit: "% gross",
        percentile: null,
        asOf: market.fetchedAt,
        detail: "Absolute gross current exposure",
      },
      {
        id: "top-five",
        label: "Largest five",
        value: book.topFive * 100,
        unit: "% gross",
        percentile: null,
        asOf: market.fetchedAt,
        detail: "Absolute gross current exposure",
      },
      {
        id: "hhi",
        label: "HHI",
        value: book.hhi,
        unit: "ratio",
        percentile: null,
        asOf: market.fetchedAt,
        detail: `${book.effectiveHoldings.toFixed(2)} effective holdings`,
      },
    );
  return {
    portfolio,
    holdings,
    book,
    basket,
    sample,
    metrics,
    factors,
    correlation,
    stresses,
    performance,
    attribution,
    greeks,
    evidence,
    rows,
    complete: completeBasket && metrics.some((row) => row.value != null),
    warnings: [...new Set(warnings)],
    fetchedAt: market.fetchedAt,
  };
}
export type PortfolioRiskModel = ReturnType<typeof buildPortfolioRisk>;
export const riskValue = (row: RiskDisplayRow) =>
  row.value == null
    ? "--"
    : `${row.value.toFixed(2)}${row.unit === "%" ? "%" : ` ${row.unit}`}`;
export const riskPercentile = (row: RiskDisplayRow) =>
  row.percentile == null ? "--" : String(Math.round(row.percentile));
