import { portfolioOptionGreeks } from "./risk-options";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { formatCurrency, formatNumber } from "../../../utils/format";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import {
  getPortfolioPositionMetrics,
  resolvePortfolioMarketValue,
} from "../../../portfolio/position-metrics";
import type { Quote } from "../../../types/financials";
import type { CloudQuotePayload } from "../../../api-client/types";
import { getCompletedRegularSessionDisplay } from "../../../market-data/market/status";
import { quoteTradingDay } from "../../../market-data/quotes/day-range";
import type { DatedReturn } from "./metrics";
import {
  computeWeightedPortfolioReturns,
  syntheticPositionUnsupportedReason,
} from "./metrics";
import {
  buyAndHoldReturns,
  concentration,
  pairedReturns,
  regressReturns,
  RISK_TAIL_CONFIDENCE,
  RISK_TAIL_MINIMUM,
  rollingBasketRisk,
  rollingBeta,
  sinceBasketRisk,
  subtractReturns,
} from "./risk-math";
import {
  repriceBook,
  RISK_SHOCK_LIMITS,
  riskCashLines,
  type RiskAssetShift,
  type RiskBookLine,
  type RiskCashLine,
  type RiskFxShift,
  type RiskRepricing,
} from "./risk-book";
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
import { accountFxPair, accountFxReason, convertReturnsToAccount, FX_UNAVAILABLE, type AccountFx } from "./risk-fx";

interface PortfolioRiskHolding {
  id: string;
  symbol: string;
  exchange: string;
  quantity: number;
  currency: string;
  /**
   * Signed value at the current USD mark, in the account currency at its
   * current rate; only these marks weight the basket.
   */
  value: number | null;
  /** Weight in the covered basket, null outside it. */
  weight: number | null;
  /** Gross current value in the portfolio currency, for the covered share only; null when nothing values it. */
  marketValue: number | null;
  priceAsOf: string | null;
  /**
   * "close" when no current quote arrived and the latest completed close marks
   * the holding; "regular-close" when the quote's regular session is over and
   * its close marks it, not a pre-market or after-hours print.
   */
  markSource?: "quote" | "close" | "regular-close" | null;
  /** The listing currency its closes were converted from at daily FX closes; null for a USD listing. */
  convertedFrom: string | null;
  historyAsOf: string | null;
  /** Daily returns in the account currency. */
  returns: DatedReturn[];
  error: string | null;
  /** Why the holding is outside the basket; null when it qualifies. */
  leftOut: string | null;
}
/** A holding or a currency's cash outside the basket, with its share of the book when one is known. */
interface RiskLeftOut {
  id: string;
  symbol: string;
  reason: string;
  value: number | null;
  share: number | null;
  /** Set on a currency's cash, which is never in the basket and does not make a report incomplete. */
  cash?: true;
}
/** One currency of the book's cash, valued in the account currency. */
interface RiskCashHolding extends RiskCashLine {
  id: string;
  /** "TRY cash". */
  symbol: string;
  /** Signed, in the portfolio currency at the current rate; null without a rate. */
  value: number | null;
}
/** What the basket views cover of the account. */
export interface RiskCoverage {
  currency: string;
  /**
   * Gross current value of the book in the portfolio currency: every holding
   * that has one, and the cash.
   */
  marketValue: number;
  coveredValue: number;
  /** Covered share of the book, cash included; an upper bound while `unvalued` lines have no value. */
  share: number | null;
  /** Gross value of the holdings alone, and the covered share of it, which `sufficient` reads. */
  holdingsValue?: number;
  holdingsShare?: number | null;
  /** Gross value of the cash in the portfolio currency. */
  cashValue?: number;
  holdings: number;
  /** Holdings that qualify for the basket. */
  covered: number;
  /** Covered holdings whose returns were converted to USD from their listing currency. */
  converted: number;
  /** Holdings and cash lines nothing values. */
  unvalued: number;
  minimumShare: number;
  /** The basket views estimate only when qualifying holdings reach the minimum share of the holdings, cash aside. */
  sufficient: boolean;
  /** Holdings and cash, largest first. */
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
  /**
   * A loss or change in money beside `value`, in `amountCurrency`: VaR and
   * expected shortfall on the covered basket's current value (`amountBase`),
   * a shock on the repriced line.
   */
  amount?: number;
  amountCurrency?: string;
  amountBase?: number;
  /** What a tail loss in money is taken on: the basket's value and share of the book, and what it leaves out. */
  basis?: string;
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
  /** Currencies' moves against USD and holdings' own price moves, applied together to every line of the book. */
  fx?: RiskFxShift[];
  assets?: RiskAssetShift[];
}
/** The benchmark the basket's returns, active return and tracking error are measured against. */
const RISK_BENCHMARK = "SPY";

/**
 * The window the risk rows cover: the trailing 60 sessions, or, with `since:
 * "filed"`, every session since the filing date of a portfolio imported from
 * a 13F.
 */
export interface RiskWindowRequest {
  since?: "filed";
  /**
   * Since the filing: "13f" (the default) buys the 13F's own weights at the
   * filing-date close and holds them; "current" holds today's weights fixed
   * over the same sessions.
   */
  weights?: "13f" | "current";
}

/** How the since-filing basket is weighted, and where 13F weights came from. */
type RiskWeighting =
  | { kind: "13f"; weights: ReadonlyMap<string, number>; source: "stored" | "cost" }
  | { kind: "current"; reason?: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Aug 2026" for 2026-08-14. */
const dayText = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""} ${date.slice(0, 4)}`;

/**
 * The 13F's own weights of an imported portfolio, by ticker: stored by the
 * import, else rebuilt from its positions. An import sizes every position at
 * the filing's reported shares, scaled, and costs it at the filing's implied
 * price, so shares times cost is each line's reported value. A position
 * without a USD cost cannot be rebuilt, and the basket says so.
 */
function thirteenFWeighting(
  portfolio: Portfolio,
  tickers: readonly TickerRecord[],
): RiskWeighting {
  const stored = Object.entries(portfolio.importedFrom?.weights ?? {})
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  if (stored.length) return { kind: "13f", weights: new Map(stored), source: "stored" };
  const values = new Map<string, number>();
  for (const ticker of portfolioRiskTickers(tickers, portfolio.id)) {
    const lots = positions(ticker, portfolio.id);
    const value = lots.reduce((sum, lot) =>
      lot.side !== "short" && lot.shares > 0 && Number.isFinite(lot.avgCost) && lot.avgCost! > 0 && (lot.currency ?? "USD") === "USD"
        ? sum + lot.shares * lot.avgCost!
        : Number.NaN, 0);
    if (!Number.isFinite(value) || value <= 0)
      return {
        kind: "current",
        reason: `"${portfolio.name}" has no stored 13F weights and ${ticker.metadata.ticker} has no USD cost to rebuild them from, so the rows hold today's weights fixed. Re-import it (portfolio import --13f ${portfolio.importedFrom?.cik ?? "<CIK>"} --replace) for buy-and-hold.`,
      };
    values.set(ticker.metadata.ticker, value);
  }
  const total = [...values.values()].reduce((sum, value) => sum + value, 0);
  return total > 0
    ? { kind: "13f", weights: new Map([...values].map(([symbol, value]) => [symbol, value / total])), source: "cost" }
    : { kind: "current", reason: `"${portfolio.name}" has no positions to weight.` };
}

/** One line naming how the since-filing rows are measured, from the close they start at. */
export function sinceFiledMethod(window: { start: string | null; filed: string; weights: "13f" | "current" }, benchmark: string): string {
  const close = dayText(window.start ?? window.filed);
  return window.weights === "13f"
    ? `Buy-and-hold from the ${close} close at the 13F's weights, against ${benchmark}`
    : `Current weights held fixed since the ${close} close, against ${benchmark}; not buy-and-hold`;
}

/** Why a portfolio asked for risk since its filing shows the trailing window instead. */
export const sinceFallbackNote = (portfolio: Pick<Portfolio, "name">) =>
  `"${portfolio.name}" was not imported from a 13F, so it has no filing date; the risk rows cover the trailing 60 sessions.`;

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
/**
 * A current quote's close once its regular session is over (after hours,
 * overnight, through a weekend, and in the pre-market while the quote reports
 * the last close), as `portfolio show --close` values a book: a pre-market or
 * after-hours print never marks a holding. Null while the session trades.
 */
function regularCloseMark(quote: CloudQuotePayload): { price: number; date: string } | null {
  const read: Quote = { ...quote, change: quote.change ?? Number.NaN, changePercent: quote.changePercent ?? Number.NaN,
    priceBasis: quote.priceBasis === "nav" ? undefined : quote.priceBasis };
  const close = getCompletedRegularSessionDisplay(read);
  const date = quote.regularCloseSessionDate ?? quoteTradingDay(read);
  return close && Number.isFinite(close.price) && close.price > 0 && date ? { price: close.price, date } : null;
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
/** Cash in the portfolio currency at the load's rates (USD per unit); null without a rate. */
function cashValue(line: RiskCashLine, accountCurrency: string, rates: Readonly<Record<string, number>>): number | null {
  const unit = resolveCurrencyUnit(line.currency);
  if (unit.currency === accountCurrency) return line.amount / unit.divisor;
  const usd = unit.currency === "USD" ? 1 : rates[unit.currency];
  const account = accountCurrency === "USD" ? 1 : rates[accountCurrency];
  const value = usd != null && usd > 0 && account != null && account > 0 ? (line.amount / unit.divisor) * usd / account : Number.NaN;
  return Number.isFinite(value) ? value : null;
}
/** Why a currency's cash is outside the basket, and for one in another currency, what moves its value. */
function cashReason(line: RiskCashLine, accountCurrency: string): string {
  const own = resolveCurrencyUnit(line.currency).currency;
  return own === accountCurrency
    ? "Cash is outside the equity basket"
    : `Cash is outside the equity basket; its ${accountCurrency} value moves with ${own}`;
}
/** USD returns in the account currency, or none with the reason its daily closes cannot convert them. */
function accountReturns(returns: readonly DatedReturn[], account: AccountFx): { returns: DatedReturn[]; error: string | null } {
  if (account.error) return { returns: [], error: account.error };
  try {
    return { returns: convertReturnsToAccount(returns, account), error: null };
  } catch (error) {
    return { returns: [], error: error instanceof Error ? error.message : accountFxReason(account.currency, FX_UNAVAILABLE) };
  }
}
/**
 * "returns in TRY at daily USD/TRY closes": the currency the basket views of a
 * non-USD account are in and how they got there; null for a USD account, or
 * when its daily closes were unavailable and nothing converted.
 */
export function riskReturnsCurrency(model: Pick<PortfolioRiskModel, "accountConversion"> | null | undefined): string | null {
  const conversion = model?.accountConversion;
  return conversion ? `returns in ${conversion.currency} at daily ${conversion.pair} closes` : null;
}
// The epsilon keeps 29 of 100 at 29%, not the 28 that 0.29 * 100 rounds down to.
const coveragePercent = (share: number) => Math.floor(share * 100 + 1e-9);
const holdingCount = (count: number) => `${count} holding${count === 1 ? "" : "s"}`;
const shareText = (share: number) =>
  share < 0.001 ? "under 0.1%" : `${(share * 100).toFixed(1)}%`;
const convertedText = (coverage: RiskCoverage) =>
  coverage.converted ? `${holdingCount(coverage.converted)} converted from local currency` : null;
/** Whole percents of shares that add up to one, the remainders handed out largest first, so a line of them adds up to 100. */
function wholePercents(shares: readonly number[]): number[] {
  const raw = shares.map((share) => share * 100);
  const whole = raw.map((value) => Math.floor(value + 1e-9));
  let left = Math.round(raw.reduce((sum, value) => sum + value, 0)) - whole.reduce((sum, value) => sum + value, 0);
  const order = raw.map((_, index) => index).sort((a, b) => raw[b]! - whole[b]! - (raw[a]! - whole[a]!));
  for (const index of order) {
    if (left <= 0) break;
    whole[index]! += 1;
    left -= 1;
  }
  return whole;
}
const percentText = (percent: number, share: number) => (percent > 0 ? `${percent}%` : share > 0 ? "under 1%" : "0%");
/** Lines the coverage line names before "N more". */
const NAMED_EXCLUSIONS = 2;
/**
 * "basket 48,286 USD = 72% of book; left out: BTC-USD 10%, TRY cash 18%": the
 * value the basket views estimate on, its share of the whole book (every
 * holding and the cash), and what it leaves out, largest first, the percents
 * adding up to 100. Past three lines left out the rest read "7 more 14%". The
 * basket's share reads "at most" while a line has no value, and a line nothing
 * values is named with "value unknown". Converted listings are counted after.
 */
export function riskCoverageLine(coverage: RiskCoverage | undefined): string | null {
  if (!coverage) return null;
  const named = coverage.leftOut.length <= NAMED_EXCLUSIONS + 1 ? coverage.leftOut : coverage.leftOut.slice(0, NAMED_EXCLUSIONS);
  const rest = coverage.leftOut.slice(named.length);
  const restShare = rest.reduce((sum, row) => sum + (row.share ?? 0), 0);
  const shares = [coverage.share ?? 0, ...named.map((row) => row.share ?? 0), ...(rest.length ? [restShare] : [])];
  const percents = wholePercents(shares);
  const basket = `basket ${formatNumber(coverage.coveredValue, 0)} ${coverage.currency}${coverage.share == null ? "" : ` = ${coverage.unvalued ? "at most " : ""}${percentText(percents[0]!, shares[0]!)} of book`}`;
  const items = [
    ...named.map((row, index) => `${row.symbol} ${row.share == null ? "value unknown" : percentText(percents[index + 1]!, row.share)}`),
    ...(rest.length ? [`${rest.length} more${restShare > 0 ? ` ${percentText(percents.at(-1)!, restShare)}` : ""}`] : []),
  ];
  return [`${basket}${items.length ? `; left out: ${items.join(", ")}` : ""}`, convertedText(coverage)].filter(Boolean).join(" · ");
}
/** Whether the basket leaves out a holding, which makes a report incomplete; cash never is in it. */
export const riskHoldingsLeftOut = (coverage: RiskCoverage) => coverage.leftOut.some((row) => !row.cash);
/**
 * "historical, 1-day, 95%, 60 daily returns": how VaR and expected shortfall
 * are estimated, from the sample they read; without an estimate, how many
 * returns it needs.
 */
function riskTailMethod(samples: number, estimated: boolean): string {
  const head = `historical, 1-day, ${Math.round(RISK_TAIL_CONFIDENCE * 100)}%`;
  return estimated
    ? `${head}, ${samples} daily returns`
    : `${head}; needs ${RISK_TAIL_MINIMUM} daily returns${samples ? `, has ${samples}` : ""}`;
}
/** The unit of the concentration shares, which divide the priced holdings' value, cash aside. */
export const HOLDINGS_SHARE_UNIT = "% holdings";
/** A reason reads as the tail of a sentence, so its first word loses its capital unless it is an acronym ("FX", "USD"). */
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);
/** One sentence per holding or cash left out, largest first, naming it and why it is out. */
export function riskCoverageNotices(coverage: RiskCoverage | undefined): string[] {
  if (!coverage?.leftOut.length) return [];
  return coverage.leftOut.map(
    (row) =>
      `${row.symbol} (${row.share == null ? "value unknown" : `${shareText(row.share)} of the book`}) is excluded from the risk estimate: ${lowerFirst(row.reason.replace(/\.$/, ""))}.`,
  );
}
/** Why the basket views show no estimate, when too little of the holdings qualifies. */
export function riskCoverageShortfall(
  coverage: RiskCoverage | undefined,
): { title: string; message: string } | null {
  if (!coverage || coverage.sufficient) return null;
  if (!coverage.holdings) return { title: "No holdings in this portfolio.", message: "" };
  const minimum = Math.round(coverage.minimumShare * 100);
  // A share of what is invested: cash is no holding the basket could take.
  const share = coverage.holdingsShare !== undefined ? coverage.holdingsShare : coverage.share;
  const base = coverage.holdingsValue ?? coverage.marketValue;
  const reasons = new Map<string, { share: number; count: number }>();
  for (const row of coverage.leftOut) {
    if (row.cash) continue;
    const entry = reasons.get(row.reason) ?? { share: 0, count: 0 };
    entry.share += row.value != null && base > 0 ? row.value / base : 0;
    entry.count += 1;
    reasons.set(row.reason, entry);
  }
  const [reason, largest] = [...reasons].sort(
    ([, left], [, right]) => right.share - left.share || right.count - left.count,
  )[0] ?? [];
  return {
    title: coverage.covered === 0 || share == null
      ? `No holding qualifies for basket estimates, which need ${minimum}% of the holdings' value.`
      : `Qualifying holdings cover ${coverage.unvalued ? "at most " : ""}${coveragePercent(share)}% of the holdings' value; basket estimates need ${minimum}%.`,
    message: reason
      ? `Most of what is left out: ${reason}${largest!.share > 0 ? ` (${shareText(largest!.share)} of the holdings' value)` : ""}.`
      : "",
  };
}
/**
 * The stress rows of the given shocks: each line they move, its change in
 * percent of its own value and in money, then the book's total, in percent of
 * its net value with the cash.
 */
/** The Stress row that totals the currency and price shocks over the whole book. */
export const BOOK_TOTAL_ROW_ID = "shock:book";
/** A Stress row of the currency and price shocks, which reprice the book without the basket. */
export function isShockRow(row: Pick<RiskDisplayRow, "id">): boolean {
  return row.id.startsWith("shock:");
}
function repricingRows(repricing: RiskRepricing, currency: string, asOf: string): RiskDisplayRow[] {
  const money = (value: number) => `${formatNumber(value, 0)} ${currency}`;
  return [
    ...repricing.lines.map((line) => ({
      id: `shock:${line.id}`,
      label: line.label,
      value: line.percent,
      unit: "%",
      percentile: null,
      asOf,
      detail: `${line.shocks.join(", ")}; ${line.before == null || line.after == null ? "value unknown, not repriced" : `${money(line.before)} to ${money(line.after)}`}`,
      ...(line.change != null ? { amount: line.change, amountCurrency: currency } : {}),
    })),
    {
      id: BOOK_TOTAL_ROW_ID,
      label: "Book total",
      value: repricing.percent,
      unit: "%",
      percentile: null,
      asOf,
      detail: `${repricing.scenario}; of ${money(repricing.bookValue)} book, cash included${repricing.unvalued.length ? `; ${repricing.unvalued.join(", ")} without a value not repriced` : ""}`,
      amount: repricing.change,
      amountCurrency: currency,
    },
  ];
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
  window: RiskWindowRequest = {},
  /** The book's cash by currency; the portfolio's own entry when left out. */
  cash: readonly RiskCashLine[] = riskCashLines(portfolio, null),
) {
  if (
    ![shifts.equity, shifts.rates, shifts.volatility].every(Number.isFinite) ||
    shifts.equity <= -100 ||
    Math.abs(shifts.equity) > 100 ||
    Math.abs(shifts.rates) > 500 ||
    shifts.volatility < -50 ||
    shifts.volatility > 100 ||
    [...(shifts.fx ?? []), ...(shifts.assets ?? [])].some((shift) =>
      !Number.isFinite(shift.percent) || shift.percent < RISK_SHOCK_LIMITS.minimum || shift.percent > RISK_SHOCK_LIMITS.maximum)
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
  // A non-USD account converts every USD return at its currency's daily closes and every USD mark at its current rate.
  const account: AccountFx | null =
    portfolio.currency === "USD"
      ? null
      : market.accountFx?.currency === portfolio.currency
        ? market.accountFx
        : {
            currency: portfolio.currency,
            pair: accountFxPair(portfolio.currency),
            closes: {},
            first: null,
            asOf: null,
            error: accountFxReason(portfolio.currency, FX_UNAVAILABLE),
          };
  // Without a current rate the latest daily close values the account.
  const latestAccountClose = account?.asOf ? account.closes[account.asOf] : undefined;
  const rates: Readonly<Record<string, number>> =
    account && !((market.fxRates?.[account.currency] ?? 0) > 0) && latestAccountClose
      ? { ...market.fxRates, [account.currency]: latestAccountClose }
      : (market.fxRates ?? {});
  const accountRate = account ? rates[account.currency] : undefined;
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
    // A current quote marks the holding, at its close once the regular session
    // is over; otherwise its latest completed close does. A converted quote's
    // session fields are still in its listing currency, and its venue has no
    // extended prints to leave out.
    const close = history?.closeMark ?? null;
    const regularClose = !close && quote && !quote.stale && !history?.converted ? regularCloseMark(quote) : null;
    const mark = close
      ? { price: close.price, currency: close.currency, stale: false }
      : quote
        ? { price: regularClose?.price ?? quote.price, currency: quote.currency, stale: !!quote.stale }
        : null;
    const quantity = signedQuantity(lots);
    // A converted listing is marked and returned in USD; its own currency is what the holding records.
    const convertedFrom = history?.converted?.currency ?? null;
    const listingCurrency =
      quote?.currency ?? close?.currency ?? history?.listing?.currency ?? ticker.metadata.currency;
    const foreign = !convertedFrom && listingCurrency !== "USD";
    const usdError =
      syntheticPositionUnsupportedReason(ticker, "USD", portfolio.id) ??
      (lots.some((row) => !Number.isFinite(row.shares))
        ? "Invalid position quantity"
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
    // A holding with a USD history converts into the account currency, or is left out with the reason it cannot.
    const inAccount = account && !usdError ? accountReturns(history?.returns ?? [], account) : null;
    const error = usdError ?? inAccount?.error ?? null;
    const priceDate = close ? close.date : regularClose ? regularClose.date : quoteDate(quote?.lastUpdated);
    const marked =
      mark &&
      mark.currency === "USD" &&
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
    const accountValue = marked == null || !account ? marked : accountRate! > 0 ? marked / accountRate! : null;
    const value = accountValue != null && Number.isFinite(accountValue) ? accountValue : null;
    const returns = inAccount?.returns ?? history?.returns ?? [];
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
      markSource: close ? "close" : regularClose ? "regular-close" : quote ? "quote" : null,
      convertedFrom,
      // Converted returns end with the account currency's last daily close.
      historyAsOf: (inAccount ? inAccount.returns.at(-1)?.dateKey : null) ?? history?.asOf ?? null,
      returns,
      error,
      leftOut,
    };
  });
  // Each currency's cash once, valued in the portfolio currency.
  const cashTotals = new Map<string, number>();
  for (const line of cash)
    if (Number.isFinite(line.amount) && line.amount !== 0)
      cashTotals.set(line.currency, (cashTotals.get(line.currency) ?? 0) + line.amount);
  const cashHoldings: RiskCashHolding[] = [...cashTotals].map(([currency, amount]) => ({
    id: `cash:${currency}`,
    symbol: `${currency} cash`,
    currency,
    amount,
    value: cashValue({ currency, amount }, portfolio.currency, rates),
  }));
  const qualifying = holdings.filter((row) => row.leftOut == null);
  const valued = holdings.filter((row) => row.marketValue != null);
  const holdingsValue = valued.reduce((sum, row) => sum + row.marketValue!, 0);
  // Cash counts in the book the coverage is a share of, at its gross value as a short does.
  const cashGross = cashHoldings.reduce((sum, row) => sum + Math.abs(row.value ?? 0), 0);
  const marketValue = holdingsValue + cashGross;
  const coveredValue = qualifying.reduce((sum, row) => sum + row.value!, 0);
  const share = marketValue > 0 ? coveredValue / marketValue : null;
  // Whether the basket is most of what is invested: cash is no holding the basket could have taken.
  const holdingsShare = holdingsValue > 0 ? coveredValue / holdingsValue : null;
  const sufficient = qualifying.length > 0 && holdingsShare != null && holdingsShare >= RISK_MIN_COVERAGE;
  const bookShare = (value: number | null) => value != null && marketValue > 0 ? value / marketValue : null;
  const coverage: RiskCoverage = {
    currency: portfolio.currency,
    marketValue,
    coveredValue,
    share,
    holdingsValue,
    holdingsShare,
    cashValue: cashGross,
    holdings: holdings.length,
    covered: qualifying.length,
    converted: qualifying.filter((row) => row.convertedFrom != null).length,
    unvalued: holdings.length - valued.length + cashHoldings.filter((row) => row.value == null).length,
    minimumShare: RISK_MIN_COVERAGE,
    sufficient,
    leftOut: [
      ...holdings
        .filter((row) => row.leftOut != null)
        .map((row): RiskLeftOut => ({
          id: row.id,
          symbol: row.symbol,
          reason: row.leftOut!,
          value: row.marketValue,
          share: bookShare(row.marketValue),
        })),
      ...cashHoldings.map((row): RiskLeftOut => {
        const value = row.value == null ? null : Math.abs(row.value);
        return { id: row.id, symbol: row.symbol, reason: cashReason(row, portfolio.currency), value, share: bookShare(value), cash: true };
      }),
    ].sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
  };
  // Weights renormalize over the covered basket; nothing outside it is approximated into it.
  const members = sufficient ? qualifying : [];
  const basketWeights = members.length ? concentration(members) : null;
  for (const holding of members)
    holding.weight =
      basketWeights?.rows.find((row) => row.id === holding.id)?.weight ?? null;
  // Concentration needs a value, not a return history: it reads every holding that has one, left out of the basket or not.
  const book = concentration(
    valued.filter((row) => row.marketValue! > 0).map((row) => ({ id: row.id, value: row.marketValue })),
  );
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
  // SPY's USD returns are the market factor and the equity stress; the risk
  // rows compare the basket with SPY in the basket's own currency. A session
  // without an account close is a gap in that benchmark, never bridged, so it
  // cannot blank the holdings the closes do cover.
  const spy = proxy(RISK_BENCHMARK);
  const benchmark = account
    ? accountReturns(spy.filter((point) => account.closes[point.startDateKey] && account.closes[point.dateKey]), account).returns
    : spy;
  // Since the filing only for a portfolio that has one; any other keeps the trailing window and says why.
  const filed = window.since === "filed" ? portfolio.importedFrom?.filed ?? null : null;
  if (window.since === "filed" && !filed)
    notes.push(sinceFallbackNote(portfolio));
  // Since the filing, the copier's basket by default: the 13F's weights bought at the filing-date close and held.
  const weighting: RiskWeighting | null = !filed ? null
    : window.weights === "current" ? { kind: "current" } : thirteenFWeighting(portfolio, tickers);
  if (weighting?.kind === "current" && weighting.reason) notes.push(weighting.reason);
  let sample = pairedReturns(basket, benchmark);
  if (filed && weighting?.kind === "13f") {
    const weights = weighting.weights;
    const held = members.filter((row) => weights.has(row.symbol));
    const outside = members.filter((row) => !weights.has(row.symbol)).map((row) => row.symbol);
    const owned = new Set(holdings.map((row) => row.symbol));
    const sold = [...weights.keys()].filter((symbol) => !owned.has(symbol));
    if (weighting.source === "cost")
      notes.push("13F weights rebuilt from each position's shares and cost, as imported; this portfolio predates stored 13F weights.");
    if (outside.length)
      notes.push(`Not in the 13F import, so outside the buy-and-hold basket: ${outside.join(", ")}.`);
    if (sold.length)
      notes.push(`No longer held, so the 13F weights are renormalised without: ${sold.join(", ")}.`);
    const basket = buyAndHoldReturns(
      held.map((row) => ({ weight: weights.get(row.symbol)!, returns: row.returns })),
      filed,
      benchmark,
    );
    // A basket that stops early, or a holding it could not buy, is named rather than read as the whole span.
    if (basket.cutShort)
      notes.push(`The buy-and-hold rows end on ${basket.cutShort.date}: ${held[basket.cutShort.holding]!.symbol} has no daily close after it.`);
    if (basket.unpriced.length)
      notes.push(`No close on or before the ${filed} filing, so outside the buy-and-hold basket: ${basket.unpriced.map((index) => held[index]!.symbol).join(", ")}.`);
    sample = pairedReturns(basket.returns, benchmark);
  }
  const metrics = filed
    ? sinceBasketRisk(sample, filed, RISK_BENCHMARK)
    : rollingBasketRisk(sample, undefined, RISK_BENCHMARK);
  // Factor proxies stay in USD: a beta is the account-currency move per unit of the factor as it trades.
  const factors = [
    { id: "market", label: "Market (SPY)", series: spy },
    {
      id: "size",
      label: "Size (IWM - SPY)",
      series: subtractReturns(proxy("IWM"), spy),
    },
    {
      id: "value",
      label: "Value (IWD - IWF)",
      series: subtractReturns(proxy("IWD"), proxy("IWF")),
    },
    {
      id: "momentum",
      label: "Momentum (MTUM - SPY)",
      series: subtractReturns(proxy("MTUM"), spy),
    },
    {
      id: "quality",
      label: "Quality (QUAL - SPY)",
      series: subtractReturns(proxy("QUAL"), spy),
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
      series: spy,
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
  // The given currency and price shocks reprice every line of the book, cash included, at once.
  const bookLines: RiskBookLine[] = [
    ...holdings.map((row) => ({
      id: row.id,
      label: row.symbol,
      currency: row.convertedFrom ?? row.currency,
      // A holding outside the USD marks keeps its gross value, signed as its position is.
      value: row.value ?? (row.marketValue == null ? null : row.quantity < 0 ? -row.marketValue : row.marketValue),
      listing: { symbol: row.symbol, exchange: row.exchange },
    })),
    ...cashHoldings.map((row) => ({ id: row.id, label: row.symbol, currency: row.currency, value: row.value, listing: null })),
  ];
  const repricing = repriceBook(bookLines, portfolio.currency, shifts.fx, shifts.assets);
  if (repricing?.unmatched.length) {
    const held = holdings.map((row) => row.symbol);
    for (const { kind, name } of repricing.unmatched)
      notes.push(kind === "currency"
        ? `Nothing in "${portfolio.name}" moves with ${name} against USD, so the ${name} shift changes nothing.`
        : `"${portfolio.name}" holds no ${name}, so its shift changes nothing${held.length ? `; it holds ${held.slice(0, 8).join(", ")}${held.length > 8 ? ` and ${held.length - 8} more` : ""}` : ""}.`);
  }
  if (sufficient)
    for (const factor of factors)
      if (factor.samples === 0)
        warnings.push(`${factor.label}: no matched factor history`);
  if (sufficient && metrics.every((row) => row.value == null))
    warnings.push(filed
      ? `No completed session since the 13F filing on ${filed} yet.`
      : "Fewer than 60 consecutive matched completed daily returns.");
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
        // The tail rows name how they are estimated; the other rows' method (price returns, bought and held or at fixed current weights) is in docs.
        detail: TAIL_ROW_IDS.has(row.id) ? riskTailMethod(row.samples, row.value != null) : `${row.samples} sessions`,
        ...(tail
          ? {
              amount: (row.value! / 100) * coverage.coveredValue,
              amountCurrency: coverage.currency,
              amountBase: coverage.coveredValue,
              basis: riskCoverageLine(coverage) ?? undefined,
            }
          : {}),
      };
    }),
    factors: factors.map((row) => ({
      ...row,
      percentile: row.rank.percentile,
      detail: `${row.samples} sessions; R² ${row.regression?.rSquared?.toFixed(2) ?? "--"}; independent ETF proxy`,
    })),
    // Largest current value first, left-out holdings and each currency's cash in place; unvalued ones last.
    holdings: [
      ...holdings.map((row) => ({
        size: row.marketValue,
        row: {
          id: row.id,
          label: row.symbol,
          value: row.weight == null ? null : row.weight * 100,
          unit: "% basket",
          percentile: null,
          asOf: row.priceAsOf,
          detail: row.leftOut
            ? row.leftOut
            : `${row.quantity} shares; ${formatNumber(row.value ?? undefined)} ${portfolio.currency}${row.markSource === "close" || row.markSource === "regular-close" ? ` at ${row.priceAsOf} close` : ""}${row.convertedFrom ? ` from ${row.convertedFrom} at daily FX` : ""}; history ${row.historyAsOf}`,
          ...(row.leftOut ? { leftOut: row.leftOut } : {}),
        } as RiskDisplayRow,
      })),
      ...cashHoldings.map((row) => {
        const amount = `${formatNumber(row.amount)} ${row.currency}`;
        const foreign = resolveCurrencyUnit(row.currency).currency !== portfolio.currency;
        return {
          size: row.value == null ? null : Math.abs(row.value),
          row: {
            id: row.id,
            label: row.symbol,
            value: null,
            unit: "% basket",
            percentile: null,
            asOf: market.fetchedAt,
            // What it is worth in the account currency and what moves it; the value column says it is left out.
            detail: [
              !foreign ? amount : row.value == null ? `${amount}; no current ${row.currency} rate values it` : `${amount} = ${formatNumber(row.value)} ${portfolio.currency}`,
              ...(foreign ? [`moves with ${row.currency}`] : []),
              "outside the basket",
            ].join("; "),
            leftOut: cashReason(row, portfolio.currency),
          } as RiskDisplayRow,
        };
      }),
    ]
      .sort((a, b) => (b.size ?? -1) - (a.size ?? -1))
      .map(({ row }) => row),
    correlation: correlation.map((row) => ({
      id: `${row.left}/${row.right}`,
      label: row.label,
      value: row.value,
      unit: "correlation",
      percentile: null,
      asOf: row.asOf ?? null,
      detail: `${row.samples ?? 0} matched daily returns`,
    })),
    stress: [
      // A regression scenario moves the basket by its beta; it is a share of the basket, not of the book.
      ...stresses.map((row) => ({
        id: row.id,
        label: row.label,
        value: row.value,
        unit: "%",
        percentile: null,
        asOf: row.regression?.asOf ?? null,
        detail: `% of basket; ${row.regression?.samples ?? 0} sessions; R² ${row.regression?.rSquared?.toFixed(2) ?? "--"}; ${row.source}`,
      })),
      ...(repricing ? repricingRows(repricing, portfolio.currency, market.fetchedAt) : []),
    ],
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
  // Concentration is of the priced holdings, cash aside, and says so with the value it divides.
  const holdingsBase = book ? `Share of ${formatNumber(book.gross, 0)} ${portfolio.currency} in priced holdings, cash aside` : "";
  if (book)
    rows.holdings.unshift(
      {
        id: "top",
        label: "Largest holding",
        value: book.top * 100,
        unit: HOLDINGS_SHARE_UNIT,
        percentile: null,
        asOf: market.fetchedAt,
        detail: holdingsBase,
      },
      {
        id: "top-five",
        label: "Largest five",
        value: book.topFive * 100,
        unit: HOLDINGS_SHARE_UNIT,
        percentile: null,
        asOf: market.fetchedAt,
        detail: holdingsBase,
      },
      {
        id: "hhi",
        label: "HHI",
        value: book.hhi,
        unit: "ratio",
        percentile: null,
        asOf: market.fetchedAt,
        detail: `${book.effectiveHoldings.toFixed(2)} effective holdings, cash aside`,
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
    cash: cashHoldings,
    repricing,
    complete:
      sufficient &&
      !riskHoldingsLeftOut(coverage) &&
      metrics.some((row) => row.value != null),
    warnings: [...new Set(warnings)],
    notes,
    fetchedAt: market.fetchedAt,
    benchmark: RISK_BENCHMARK,
    /** The currency a non-USD account's returns converted into, at the daily closes of `pair`; null for USD. */
    accountConversion:
      account && !account.error && account.pair
        ? { currency: account.currency, pair: account.pair, asOf: account.asOf }
        : null,
    window: filed
      ? {
          kind: "since-filed" as const,
          filed,
          start: metrics[0]?.startDate ?? null,
          sessions: metrics[0]?.samples ?? 0,
          weights: weighting?.kind ?? "current",
          ...(weighting?.kind === "13f" ? { weightsSource: weighting.source } : {}),
        }
      : { kind: "trailing" as const, sessions: 60 },
  };
}
export type PortfolioRiskModel = ReturnType<typeof buildPortfolioRisk>;
export const riskValue = (row: RiskDisplayRow) =>
  row.leftOut
    ? "left out"
    : row.value == null
    ? "--"
    : `${row.value.toFixed(2)}${row.unit === "%" ? "%" : ` ${row.unit}`}${riskAmount(row)}`;
/** A row's evidence with what a tail loss in money is taken on: the basket, its share of the book and what it leaves out. */
export function riskEvidence(row: RiskDisplayRow): string {
  return row.basis ? `${row.detail}; ${row.basis}` : row.detail;
}
/** " ($5,735)": a loss or change in money beside its percent. */
function riskAmount(row: RiskDisplayRow): string {
  if (row.amount == null || !Number.isFinite(row.amount) || !row.amountCurrency) return "";
  return ` (${formatCurrency(row.amount, row.amountCurrency, 0)})`;
}
export const riskPercentile = (row: RiskDisplayRow) =>
  row.percentile == null ? "--" : String(Math.round(row.percentile));
