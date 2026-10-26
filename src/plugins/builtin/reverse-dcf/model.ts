import { unavailableText } from "../../../components/ui/status";
import { atRegularSessionPrice } from "../../../market-data/quotes/regular-session-valuation";
import type { Fundamentals, TickerFinancials } from "../../../types/financials";
import { fiscalPeriodLabel, fiscalYearEndMonth } from "../../../utils/fiscal-period";
import { formatCompactCurrency } from "../../../utils/format";
import { enterpriseValueCheck, enterpriseValueLabel, enterpriseValueNotMeaningful, enterpriseValueReconciliationNote,
  enterpriseValueWithdrawn, reportedEnterpriseValue } from "../../../utils/fundamentals";

/** Years of explicit growth before the terminal value. */
export const FORECAST_YEARS = 10;
export const TERMINAL_GROWTH = 0.025;
export const DISCOUNT_RATES = [0.07, 0.08, 0.09, 0.1, 0.11, 0.12];
export const TERMINAL_GROWTHS = [0.02, 0.025, 0.03];
/** The free cash flow margin the implied year-ten revenue falls back to when the company's own is not a meaningful figure. */
export const DEFAULT_FCF_MARGIN = 0.3;
/** The growth range searched; a price outside it reads as below or above. */
const MIN_GROWTH = -0.5, MAX_GROWTH = 1;

/**
 * Where the margin behind the implied revenue comes from: the company's own
 * trailing margin, one the reader chose, or `DEFAULT_FCF_MARGIN` because the
 * company's has no meaning (`gap` says why).
 */
export interface FcfMarginBasis {
  source: "company" | "chosen" | "default";
  /** Trailing free cash flow over trailing revenue, when that ratio is a margin. */
  company: number | null;
  /** Why `company` is missing. */
  gap: string | null;
}

/** A solved growth rate, or which side of the searched range the price lies on. */
export type ImpliedGrowth = { kind: "rate"; value: number } | { kind: "below" } | { kind: "above" };

export interface ReverseDcfModel {
  symbol: string;
  currency: string | null;
  discountRate: number;
  terminalGrowth: number;
  /** The enterprise value `valuation` shows: at the regular session price, the provider's even where it is labelled. */
  enterpriseValue: number | null;
  /** More than 5% from market cap + total debt - cash: the computed figure beside the provider's. */
  computedEnterpriseValue: number | null;
  /** The line `valuation` prints under a labelled EV. */
  enterpriseValueNote: string | null;
  /** Free cash flow over the last twelve months. */
  freeCashFlow: number | null;
  fcfYield: number | null;
  implied: ImpliedGrowth | null;
  /** The margin `impliedRevenue` assumes. */
  fcfMargin: number;
  fcfMarginBasis: FcfMarginBasis;
  /** Year-ten revenue at `fcfMargin`: trailing free cash flow grown at the implied rate for ten years, over the margin. */
  impliedRevenue: number | null;
  /** Annual FCF growth between the latest annual statement and one up to five years earlier, when both are positive. `period` names the two years: FY2021–FY2025. */
  pastGrowth: { rate: number; years: number; period: string } | null;
  /** The latest annual statement's free cash flow, which the past growth ends at, and the year it is of (FY2025). */
  fiscalYearFcf: { value: number; label: string } | null;
  /** Implied growth for each discount rate (rows) at each terminal growth (columns). */
  sensitivity: { discountRate: number; implied: (ImpliedGrowth | null)[] }[];
  error: string | null;
}

/** Enterprise value of `fcf` growing at `growth` for ten years, then at `terminalGrowth` forever. */
export function dcfValue(fcf: number, growth: number, discountRate: number, terminalGrowth: number): number {
  let value = 0, cash = fcf;
  for (let year = 1; year <= FORECAST_YEARS; year++) {
    cash *= 1 + growth;
    value += cash / (1 + discountRate) ** year;
  }
  const terminal = cash * (1 + terminalGrowth) / (discountRate - terminalGrowth);
  return value + terminal / (1 + discountRate) ** FORECAST_YEARS;
}

/** The ten-year growth at which the DCF equals `enterpriseValue`. Value rises with growth while FCF is positive, so bisection finds it. */
export function solveImpliedGrowth(enterpriseValue: number, fcf: number, discountRate: number, terminalGrowth: number): ImpliedGrowth | null {
  if (!(fcf > 0) || !(enterpriseValue > 0) || discountRate <= terminalGrowth) return null;
  if (dcfValue(fcf, MIN_GROWTH, discountRate, terminalGrowth) > enterpriseValue) return { kind: "below" };
  if (dcfValue(fcf, MAX_GROWTH, discountRate, terminalGrowth) < enterpriseValue) return { kind: "above" };
  let low = MIN_GROWTH, high = MAX_GROWTH;
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (dcfValue(fcf, mid, discountRate, terminalGrowth) < enterpriseValue) low = mid;
    else high = mid;
  }
  return { kind: "rate", value: (low + high) / 2 };
}

/** The latest annual statements with a free cash flow, oldest first, as many as the past growth looks back over. */
function annualFreeCashFlows(financials: TickerFinancials) {
  return financials.annualStatements
    .filter((row) => typeof row.freeCashFlow === "number" && Number.isFinite(row.freeCashFlow))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-6);
}

/** The two years a past growth spans, as issuers name them: `FY2021–FY2025`; period end dates where a year is off the fiscal calendar. */
function fiscalSpan(financials: TickerFinancials, from: string, to: string): string {
  const month = fiscalYearEndMonth(financials.annualStatements);
  const [start, end] = [from, to].map((date) => fiscalPeriodLabel(date, "annual", month)) as [string, string];
  return start.startsWith("FY") && end.startsWith("FY") ? `${start}–${end}` : `${from.slice(0, 10)} to ${to.slice(0, 10)}`;
}

function pastFcfGrowth(financials: TickerFinancials): ReverseDcfModel["pastGrowth"] {
  const annual = annualFreeCashFlows(financials);
  const first = annual[0], last = annual.at(-1);
  if (!first || !last || first === last || !(first.freeCashFlow! > 0) || !(last.freeCashFlow! > 0)) return null;
  const years = Math.round((Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86_400_000));
  return years > 0
    ? { rate: (last.freeCashFlow! / first.freeCashFlow!) ** (1 / years) - 1, years, period: fiscalSpan(financials, first.date, last.date) }
    : null;
}

function latestFiscalYearFcf(financials: TickerFinancials): ReverseDcfModel["fiscalYearFcf"] {
  const last = annualFreeCashFlows(financials).at(-1);
  return last ? { value: last.freeCashFlow!, label: fiscalPeriodLabel(last.date, "annual", fiscalYearEndMonth(financials.annualStatements)) } : null;
}

/** How far above the latest fiscal year's free cash flow the trailing twelve months' must be to say the two bases differ. */
const TTM_BASE_RATIO = 1.5;

/**
 * How a trailing free cash flow more than 1.5 times the latest fiscal year's
 * differs from it (`2.7x` FY2025's `5.3B USD`): the growth priced in starts
 * from the trailing figure, the past growth ends at the year's. Null when they
 * are near each other, the year's is not positive, or the model has no growth
 * to say.
 */
export function ttmBaseGap(model: Pick<ReverseDcfModel, "freeCashFlow" | "fiscalYearFcf" | "currency" | "error">): { multiple: string; year: string; fcf: string } | null {
  const { freeCashFlow, fiscalYearFcf } = model;
  if (model.error || freeCashFlow == null || !fiscalYearFcf || !(fiscalYearFcf.value > 0) || !(freeCashFlow > fiscalYearFcf.value * TTM_BASE_RATIO)) return null;
  return {
    multiple: `${(freeCashFlow / fiscalYearFcf.value).toFixed(1)}x`,
    year: fiscalYearFcf.label,
    fcf: formatCompactCurrency(fiscalYearFcf.value, model.currency ?? undefined),
  };
}

/** "The TTM base differs from FY2025: TTM FCF is 2.7x that year's 5.3B USD.", the one line a report adds when `ttmBaseGap` finds a gap. */
export function ttmBaseNote(model: Parameters<typeof ttmBaseGap>[0]): string | null {
  const gap = ttmBaseGap(model);
  return gap ? `The TTM base differs from ${gap.year}: TTM FCF is ${gap.multiple} that year's ${gap.fcf}.` : null;
}

/** What the past growth rate is over, after the rate: `a year, FY2021–FY2025`. */
export function pastGrowthBasis(growth: NonNullable<ReverseDcfModel["pastGrowth"]>): string {
  return `a year, ${growth.period}`;
}

/**
 * The company's trailing free cash flow margin: the twelve-month free cash
 * flow over the twelve-month revenue, which Gloom Cloud serves for the same
 * period and currency. A missing, zero or negative figure, or a free cash flow
 * above the revenue (a mismatch, not a margin), has none.
 */
function trailingFcfMargin(fundamentals: Pick<Fundamentals, "freeCashFlow" | "revenue"> | null | undefined):
  { margin: number; gap: null } | { margin: null; gap: string } {
  const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);
  const revenue = fundamentals?.revenue, fcf = fundamentals?.freeCashFlow;
  const gap = !finite(revenue) ? "no TTM revenue" : !(revenue > 0) ? "TTM revenue not positive"
    : !finite(fcf) ? "no TTM FCF" : !(fcf > 0) ? "TTM FCF not positive" : fcf > revenue ? "TTM FCF above revenue" : null;
  return gap ? { margin: null, gap } : { margin: fcf! / revenue!, gap: null };
}

/** A margin as the surfaces say it: 55.2%, 30%, 1.9%. */
export function formatFcfMargin(margin: number): string {
  return `${Number((margin * 100).toFixed(1))}%`;
}

/** The margin behind the implied revenue and where it is from, as the pane and `fn RDCF` say it: `55.2% FCF margin (company TTM)`. */
export function describeFcfMargin(margin: number, basis: FcfMarginBasis): string {
  const company = basis.company == null ? "" : formatFcfMargin(basis.company);
  const source = basis.source === "company" ? "company TTM"
    : basis.source === "chosen" ? `chosen${company ? `; company TTM ${company}` : ""}`
    : `default; ${basis.gap ?? "company margin unavailable"}`;
  return `${formatFcfMargin(margin)} FCF margin (${source})`;
}

/** Revenue in the last forecast year: the free cash flow grown at `growth` over the margin it is taken to be. */
function impliedYearTenRevenue(fcf: number, growth: number, fcfMargin: number): number | null {
  return fcf > 0 && fcfMargin > 0 && fcfMargin <= 1 ? fcf * (1 + growth) ** FORECAST_YEARS / fcfMargin : null;
}

export function projectReverseDcf(
  financials: TickerFinancials | null,
  /** `fcfMargin` is the margin the reader chose; without one the company's own trailing margin applies. */
  options: { symbol: string; discountRate: number; fcfMargin?: number },
): ReverseDcfModel {
  // The enterprise value at the regular session price, as `valuation` measures it: after the close, the close's.
  const fundamentals = financials ? atRegularSessionPrice(financials).fundamentals : undefined;
  const currency = fundamentals?.financialCurrency ?? financials?.financialCurrency ?? null;
  const enterpriseValue = reportedEnterpriseValue(fundamentals) ?? null;
  const check = enterpriseValueLabel(fundamentals) === "provider" ? enterpriseValueCheck(fundamentals) : undefined;
  const freeCashFlow = fundamentals?.freeCashFlow ?? null;
  const company = trailingFcfMargin(fundamentals);
  const fcfMargin = options.fcfMargin ?? company.margin ?? DEFAULT_FCF_MARGIN;
  const fcfMarginBasis: FcfMarginBasis = { company: company.margin, gap: company.gap,
    source: options.fcfMargin != null ? "chosen" : company.margin != null ? "company" : "default" };
  const empty: ReverseDcfModel = { symbol: options.symbol, currency, discountRate: options.discountRate, terminalGrowth: TERMINAL_GROWTH,
    enterpriseValue, computedEnterpriseValue: check?.computed ?? null, enterpriseValueNote: check ? enterpriseValueReconciliationNote(fundamentals) ?? null : null,
    freeCashFlow, fcfYield: null, implied: null, fcfMargin, fcfMarginBasis, impliedRevenue: null,
    pastGrowth: financials ? pastFcfGrowth(financials) : null, fiscalYearFcf: financials ? latestFiscalYearFcf(financials) : null,
    sensitivity: [], error: null };
  const valueCurrency = fundamentals?.marketCapCurrency;
  // ADRs and cross-listings can report cash flows in one currency and trade in another.
  if (currency && valueCurrency && currency !== valueCurrency) {
    return { ...empty, error: `Cash flows are in ${currency} and the market value in ${valueCurrency}.` };
  }
  // An EV at or below zero is N/M here as in `valuation` and RV, with the same reason: no growth rate prices it.
  if (enterpriseValueNotMeaningful(fundamentals)) {
    return { ...empty, enterpriseValue: null, error: enterpriseValueReconciliationNote(fundamentals)! };
  }
  // A withdrawn EV is unavailable here as in `valuation`, which says why.
  if (enterpriseValueWithdrawn(fundamentals)) {
    return { ...empty, error: enterpriseValueReconciliationNote(fundamentals) ?? unavailableText("Enterprise value") };
  }
  if (enterpriseValue == null || !(enterpriseValue > 0)) return { ...empty, error: unavailableText("Enterprise value") };
  if (freeCashFlow == null) return { ...empty, error: unavailableText("Free cash flow") };
  if (!(freeCashFlow > 0)) return { ...empty, error: "Free cash flow over the last twelve months is negative, so no growth rate prices it." };
  const implied = solveImpliedGrowth(enterpriseValue, freeCashFlow, options.discountRate, TERMINAL_GROWTH);
  return {
    ...empty,
    fcfYield: freeCashFlow / enterpriseValue,
    implied,
    impliedRevenue: implied?.kind === "rate" ? impliedYearTenRevenue(freeCashFlow, implied.value, fcfMargin) : null,
    sensitivity: DISCOUNT_RATES.map((discountRate) => ({ discountRate,
      implied: TERMINAL_GROWTHS.map((terminal) => solveImpliedGrowth(enterpriseValue, freeCashFlow, discountRate, terminal)) })),
  };
}
