import { portfolioOptionGreeks } from "./risk-options";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { formatCurrency, formatNumber } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import {
  getPortfolioPositionMetrics,
  resolvePortfolioMarketValue,
} from "../portfolio-list/position-metrics";
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
  type RiskHoldingRequest,
  type RiskMarketSnapshot,
} from "./risk-client";

interface PortfolioRiskHolding {
  id: string;
  symbol: string;
  exchange: string;
  quantity: number;
  currency: string;
  /** Signed USD value at the current mark; only these marks weight the basket. */
  value: number | null;
  /** Weight in the covered basket, null outside it. */
  weight: number | null;
  /** Gross current value in the portfolio currency, for the covered share only; null when nothing values it. */
  marketValue: number | null;
  priceAsOf: string | null;
  /** "close" when no current quote arrived and the latest completed close marks the holding. */
  markSource?: "quote" | "close" | null;
  /** The listing currency its closes were converted from at daily FX closes; null for a USD listing. */
  convertedFrom: string | null;
  historyAsOf: string | null;
  returns: DatedReturn[];
  error: string | null;
  /** Why the holding is outside the basket; null when it qualifies. */
  leftOut: string | null;
}
/** A holding outside the basket, with its share of market value when one is known. */
interface RiskLeftOut {
  id: string;
  symbol: string;
  reason: string;
  value: number | null;
  share: number | null;
}
/** What the basket views cover of the account. */
export interface RiskCoverage {
  currency: string;
  /** Gross current value of every holding that has one, in the portfolio currency. */
  marketValue: number;
  coveredValue: number;
  /** Covered share of market value; an upper bound while `unvalued` holdings have no value. */
  share: number | null;
  holdings: number;
  /** Holdings that qualify for the basket. */
  covered: number;
  /** Covered holdings whose returns were converted to USD from their listing currency. */
  converted: number;
  unvalued: number;
  minimumShare: number;
  /** The basket views estimate only when qualifying holdings reach the minimum share. */
  sufficient: boolean;
  /** Largest first. */
  leftOut: RiskLeftOut[];
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
  /** Holdings rows only: why the holding is outside the covered basket. */
  leftOut?: string;
  /** VaR and expected shortfall only: the loss `value` is on the covered basket's current value (`amountBase`), in `amountCurrency`. */
  amount?: number;
  amountCurrency?: string;
  amountBase?: number;
}
/** The tail-loss rows, which also read in money on the covered basket. */
const TAIL_ROW_IDS: ReadonlySet<string> = new Set(["var", "es"]);
/**
 * Below half of market value the qualifying holdings are not most of the
 * account, so a basket estimate would mostly describe something other than it;
 * the basket views say why instead of estimating.
 */
const RISK_MIN_COVERAGE = 0.5;
/** Views computed from the covered basket; the others read the whole account or its option book. */
export const BASKET_VIEWS: ReadonlySet<RiskView> = new Set(["risk", "factors", "holdings", "correlation", "stress"]);
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
const DEFAULT_RISK_SHIFTS: RiskShifts = {
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
const signedQuantity = (lots: TickerRecord["metadata"]["positions"]) =>
  lots.reduce(
    (sum, row) => sum + (row.side === "short" ? -Math.abs(row.shares) : row.shares),
    0,
  );
/** What the market load needs to rank holdings by value and skip the ones the basket cannot take. */
export function portfolioRiskRequests(
  tickers: readonly TickerRecord[],
  portfolioId: string,
): RiskHoldingRequest[] {
  return tickers.map((ticker) => {
    const lots = positions(ticker, portfolioId);
    const currency = lots.find((row) => row.currency)?.currency ?? ticker.metadata.currency;
    const snapshot = lots.every(
      (row) => Number.isFinite(row.marketValue) && (row.currency ?? ticker.metadata.currency) === "USD",
    )
      ? lots.reduce((sum, row) => sum + Math.abs(row.marketValue!), 0)
      : null;
    return {
      symbol: ticker.metadata.ticker,
      exchange: ticker.metadata.exchange,
      quantity: signedQuantity(lots),
      currency,
      snapshotValue: snapshot,
      unsupported:
        syntheticPositionUnsupportedReason(ticker, "USD", portfolioId) != null ||
        lots.some((row) => !Number.isFinite(row.shares)),
    };
  });
}
/**
 * Current gross value of a holding outside the USD marks, in the portfolio
 * currency: its listing price, else the broker's snapshot, at the load's rates.
 * It sizes what is left out and never enters a return.
 */
function outsideValue(
  ticker: TickerRecord,
  portfolio: Portfolio,
  price: { price: number; currency: string } | null,
  rates: Readonly<Record<string, number>>,
): number | null {
  const toUsd = (value: number, currency: string) => {
    const unit = resolveCurrencyUnit(currency);
    const rate = unit.currency === "USD" ? 1 : rates[unit.currency];
    return rate != null && rate > 0 ? (value * rate) / unit.divisor : Number.NaN;
  };
  const toAccount = (value: number, currency: string) => {
    if (currency === portfolio.currency) return value;
    const rate = portfolio.currency === "USD" ? 1 : rates[portfolio.currency];
    return rate != null && rate > 0 ? toUsd(value, currency) / rate : Number.NaN;
  };
  const metrics = getPortfolioPositionMetrics(ticker, portfolio.id, ticker.metadata.currency, {
    currency: portfolio.currency,
    convert: toAccount,
  });
  const unit = price && Number.isFinite(price.price) && price.price > 0
    ? toAccount(price.price, price.currency)
    : null;
  const value = resolvePortfolioMarketValue(metrics, unit != null && Number.isFinite(unit) ? unit : null)?.gross;
  return value != null && Number.isFinite(value) ? value : null;
}
const coveragePercent = (share: number) => Math.floor(share * 100);
const holdingCount = (count: number) => `${count} holding${count === 1 ? "" : "s"}`;
const shareText = (share: number) =>
  share < 0.001 ? "under 0.1%" : `${(share * 100).toFixed(1)}%`;
/**
 * "covers 78% of market value · 9 holdings left out · 2 converted from local
 * currency", or null when every holding is in the basket in its own USD listing.
 */
export function riskCoverageText(coverage: RiskCoverage | undefined): string | null {
  if (!coverage) return null;
  const converted = coverage.converted ? `${holdingCount(coverage.converted)} converted from local currency` : null;
  if (!coverage.leftOut.length) return converted;
  const covers = coverage.share == null
    ? "covers an unknown share of market value"
    : `covers ${coverage.unvalued ? "at most " : ""}${coveragePercent(coverage.share)}% of market value`;
  return [covers, `${holdingCount(coverage.leftOut.length)} left out`, ...(converted ? [converted] : [])].join(" · ");
}
/** A reason reads as the tail of a sentence, so its first word loses its capital unless it is an acronym ("FX", "USD"). */
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);
/** One sentence per left-out holding, largest first, naming the holding and why it is out. */
export function riskCoverageNotices(coverage: RiskCoverage | undefined): string[] {
  if (!coverage?.leftOut.length) return [];
  return coverage.leftOut.map(
    (row) =>
      `${row.symbol} (${row.share == null ? "value unknown" : `${shareText(row.share)} of market value`}) is excluded from the risk estimate: ${lowerFirst(row.reason.replace(/\.$/, ""))}.`,
  );
}
/** Why the basket views show no estimate, when too little of the account qualifies. */
export function riskCoverageShortfall(
  coverage: RiskCoverage | undefined,
): { title: string; message: string } | null {
  if (!coverage || coverage.sufficient) return null;
  if (!coverage.holdings) return { title: "No holdings in this portfolio.", message: "" };
  const minimum = Math.round(coverage.minimumShare * 100);
  const reasons = new Map<string, { share: number; count: number }>();
  for (const row of coverage.leftOut) {
    const entry = reasons.get(row.reason) ?? { share: 0, count: 0 };
    entry.share += row.share ?? 0;
    entry.count += 1;
    reasons.set(row.reason, entry);
  }
  const [reason, largest] = [...reasons].sort(
    ([, left], [, right]) => right.share - left.share || right.count - left.count,
  )[0] ?? [];
  return {
    title: coverage.covered === 0 || coverage.share == null
      ? `No holding qualifies for basket estimates, which need ${minimum}% of market value.`
      : `Qualifying holdings cover ${coverage.unvalued ? "at most " : ""}${coveragePercent(coverage.share)}% of market value; basket estimates need ${minimum}%.`,
    message: reason
      ? `Most of what is left out: ${reason}${largest!.share > 0 ? ` (${shareText(largest!.share)} of market value)` : ""}.`
      : "",
  };
}
/**
 * Basket estimates use the holdings that qualify, reweighted among themselves.
 * Every other holding stays listed with its reason and counts in the market
 * value they are measured against.
 */
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
  const rates = market.fxRates ?? {};
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
    const quantity = signedQuantity(lots);
    // A converted listing is marked and returned in USD; its own currency is what the holding records.
    const convertedFrom = history?.converted?.currency ?? null;
    const listingCurrency =
      quote?.currency ?? close?.currency ?? history?.listing?.currency ?? ticker.metadata.currency;
    const foreign = !convertedFrom && listingCurrency !== "USD";
    const error =
      syntheticPositionUnsupportedReason(ticker, "USD", portfolio.id) ??
      (lots.some((row) => !Number.isFinite(row.shares))
        ? "Invalid position quantity"
        : null) ??
      (portfolio.currency !== "USD"
        ? "Historical account-currency FX is required"
        : null) ??
      (ticker.metadata.currency &&
      (convertedFrom ?? mark?.currency) &&
      ticker.metadata.currency !== (convertedFrom ?? mark?.currency)
        ? "Holding and quote currencies differ"
        : null) ??
      // A foreign listing that did not convert says why: no pair, stale or gapped FX.
      (foreign
        ? (history?.error ?? syntheticPositionUnsupportedReason(ticker, listingCurrency, portfolio.id))
        : null) ??
      history?.error ??
      (!history ? "Daily history unavailable" : null);
    const priceDate = close ? close.date : quoteDate(quote?.lastUpdated);
    const marked =
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
    const value = marked != null && Number.isFinite(marked) ? marked : null;
    const returns = history?.returns ?? [];
    const leftOut =
      error ??
      (value == null || value <= 0
        ? "No current USD mark"
        : returns.length < 60
          ? "Fewer than 60 daily returns"
          : null);
    return {
      id,
      ...instrument,
      quantity,
      currency: listingCurrency,
      value,
      weight: null,
      marketValue:
        value != null
          ? Math.abs(value)
          : outsideValue(ticker, portfolio, quote ?? history?.listing ?? null, rates),
      priceAsOf: priceDate,
      markSource: close ? "close" : quote ? "quote" : null,
      convertedFrom,
      historyAsOf: history?.asOf ?? null,
      returns,
      error,
      leftOut,
    };
  });
  const qualifying = holdings.filter((row) => row.leftOut == null);
  const valued = holdings.filter((row) => row.marketValue != null);
  const marketValue = valued.reduce((sum, row) => sum + row.marketValue!, 0);
  const coveredValue = qualifying.reduce((sum, row) => sum + row.value!, 0);
  const share = marketValue > 0 ? coveredValue / marketValue : null;
  const sufficient = qualifying.length > 0 && share != null && share >= RISK_MIN_COVERAGE;
  const coverage: RiskCoverage = {
    currency: portfolio.currency,
    marketValue,
    coveredValue,
    share,
    holdings: holdings.length,
    covered: qualifying.length,
    converted: qualifying.filter((row) => row.convertedFrom != null).length,
    unvalued: holdings.length - valued.length,
    minimumShare: RISK_MIN_COVERAGE,
    sufficient,
    leftOut: holdings
      .filter((row) => row.leftOut != null)
      .sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1))
      .map((row) => ({
        id: row.id,
        symbol: row.symbol,
        reason: row.leftOut!,
        value: row.marketValue,
        share: row.marketValue != null && marketValue > 0 ? row.marketValue / marketValue : null,
      })),
  };
  // Weights renormalize over the covered basket; nothing outside it is approximated into it.
  const members = sufficient ? qualifying : [];
  const book = members.length ? concentration(members) : null;
  for (const holding of members)
    holding.weight =
      book?.rows.find((row) => row.id === holding.id)?.weight ?? null;
  const closeMarked = members.filter((row) => row.markSource === "close").length;
  const converted = members.filter((row) => row.convertedFrom != null).length;
  const held = new Set(holdings.map((row) => row.id));
  // Caveats about an estimate that was made; the warnings are what failed.
  const notes = [
    ...(closeMarked
      ? [
          `${closeMarked} holding${closeMarked === 1 ? "" : "s"} had no current quote; weighted at the latest completed close.`,
        ]
      : []),
    // Daily closes pair by date, so a market that closes before or after the US session is not synchronous with it.
    ...(converted
      ? [
          "Converted holdings are matched to the US close of the same date; where their market closes at another time, correlations and betas to US holdings read lower than they are.",
        ]
      : []),
  ];
  const warnings = [
    ...market.warnings,
    // A held instrument's failure is its left-out reason; factor proxies report here.
    ...market.histories.flatMap((row) =>
      row.error && !held.has(riskInstrumentId(row.instrument))
        ? [`${row.instrument.symbol}: ${row.error}`]
        : [],
    ),
  ];
  const basket = members.length
    ? computeWeightedPortfolioReturns(
        members.map((row) => ({ weight: row.weight!, returns: row.returns })),
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
  const correlation = members.flatMap((left, index) =>
    members.slice(index + 1).map((right) => {
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
  if (sufficient)
    for (const factor of factors)
      if (factor.samples === 0)
        warnings.push(`${factor.label}: no matched factor history`);
  if (sufficient && metrics.every((row) => row.value == null))
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
    risk: metrics.map((row) => {
      // VaR and expected shortfall are a one-day loss on the covered basket's current value, in the portfolio currency.
      const tail = TAIL_ROW_IDS.has(row.id) && row.value != null && coverage.coveredValue > 0;
      return {
        ...row,
        percentile: row.rank.percentile,
        // The method (price returns at fixed current weights) is in docs; the footer keeps room for coverage.
        detail: `${row.samples} sessions`,
        ...(tail
          ? { amount: (row.value! / 100) * coverage.coveredValue, amountCurrency: coverage.currency, amountBase: coverage.coveredValue }
          : {}),
      };
    }),
    factors: factors.map((row) => ({
      ...row,
      percentile: row.rank.percentile,
      detail: `${row.samples} sessions; R² ${row.regression?.rSquared?.toFixed(2) ?? "--"}; independent ETF proxy`,
    })),
    // Largest current value first, left-out holdings in place; unvalued ones last.
    holdings: [...holdings]
      .sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1))
      .map((row) => ({
      id: row.id,
      label: row.symbol,
      value: row.weight == null ? null : row.weight * 100,
      unit: "% basket",
      percentile: null,
      asOf: row.priceAsOf,
      detail: row.leftOut
        ? row.leftOut
        : `${row.quantity} shares; ${formatNumber(row.value ?? undefined)} ${row.currency}${row.markSource === "close" ? ` at ${row.priceAsOf} close` : ""}${row.convertedFrom ? ` from ${row.convertedFrom} at daily FX` : ""}; history ${row.historyAsOf}`,
      ...(row.leftOut ? { leftOut: row.leftOut } : {}),
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
        unit: "% basket",
        percentile: null,
        asOf: market.fetchedAt,
        detail: "Current value in the covered basket",
      },
      {
        id: "top-five",
        label: "Largest five",
        value: book.topFive * 100,
        unit: "% basket",
        percentile: null,
        asOf: market.fetchedAt,
        detail: "Current value in the covered basket",
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
    coverage,
    complete:
      sufficient &&
      coverage.leftOut.length === 0 &&
      metrics.some((row) => row.value != null),
    warnings: [...new Set(warnings)],
    notes,
    fetchedAt: market.fetchedAt,
  };
}
export type PortfolioRiskModel = ReturnType<typeof buildPortfolioRisk>;
export const riskValue = (row: RiskDisplayRow) =>
  row.leftOut
    ? "left out"
    : row.value == null
    ? "--"
    : `${row.value.toFixed(2)}${row.unit === "%" ? "%" : ` ${row.unit}`}${riskAmount(row)}`;
/** "220,476 USD basket": the value a tail loss in money is taken on, or null for a row without one. */
export function riskAmountBase(row: Pick<RiskDisplayRow, "amountBase" | "amountCurrency">): string | null {
  return row.amountBase != null && Number.isFinite(row.amountBase) && row.amountCurrency
    ? `${formatNumber(row.amountBase, 0)} ${row.amountCurrency} basket`
    : null;
}
/** A row's evidence with the basket a tail loss in money is taken on. */
export function riskEvidence(row: RiskDisplayRow): string {
  const base = riskAmountBase(row);
  return base ? `${row.detail}; of ${base}` : row.detail;
}
/** " ($5,735)": a tail loss in money beside its percent. */
function riskAmount(row: RiskDisplayRow): string {
  if (row.amount == null || !Number.isFinite(row.amount) || !row.amountCurrency) return "";
  return ` (${formatCurrency(row.amount, row.amountCurrency, 0)})`;
}
export const riskPercentile = (row: RiskDisplayRow) =>
  row.percentile == null ? "--" : String(Math.round(row.percentile));
