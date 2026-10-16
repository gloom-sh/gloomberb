import { atRegularSessionPrice } from "../../../market-data/quotes/regular-session-valuation";
import type { TickerFinancials } from "../../../types/financials";
import { enterpriseValueCheck, enterpriseValueLabel, enterpriseValueReconciliationNote, enterpriseValueWithdrawn,
  reportedEnterpriseValue } from "../../../utils/fundamentals";

/** Years of explicit growth before the terminal value. */
export const FORECAST_YEARS = 10;
export const TERMINAL_GROWTH = 0.025;
export const DISCOUNT_RATES = [0.07, 0.08, 0.09, 0.1, 0.11, 0.12];
export const TERMINAL_GROWTHS = [0.02, 0.025, 0.03];
/** The free cash flow margin the implied year-ten revenue assumes unless told otherwise. */
export const DEFAULT_FCF_MARGIN = 0.3;
/** The growth range searched; a price outside it reads as below or above. */
const MIN_GROWTH = -0.5, MAX_GROWTH = 1;

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
  /** Year-ten revenue at `fcfMargin`: trailing free cash flow grown at the implied rate for ten years, over the margin. */
  impliedRevenue: number | null;
  /** Annual FCF growth between the latest annual statement and one up to five years earlier, when both are positive. */
  pastGrowth: { rate: number; years: number } | null;
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

function pastFcfGrowth(financials: TickerFinancials): ReverseDcfModel["pastGrowth"] {
  const annual = financials.annualStatements
    .filter((row) => typeof row.freeCashFlow === "number" && Number.isFinite(row.freeCashFlow))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-6);
  const first = annual[0], last = annual.at(-1);
  if (!first || !last || first === last || !(first.freeCashFlow! > 0) || !(last.freeCashFlow! > 0)) return null;
  const years = Math.round((Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86_400_000));
  return years > 0 ? { rate: (last.freeCashFlow! / first.freeCashFlow!) ** (1 / years) - 1, years } : null;
}

/** Revenue in the last forecast year: the free cash flow grown at `growth` over the margin it is taken to be. */
function impliedYearTenRevenue(fcf: number, growth: number, fcfMargin: number): number | null {
  return fcf > 0 && fcfMargin > 0 && fcfMargin <= 1 ? fcf * (1 + growth) ** FORECAST_YEARS / fcfMargin : null;
}

export function projectReverseDcf(
  financials: TickerFinancials | null,
  options: { symbol: string; discountRate: number; fcfMargin?: number },
): ReverseDcfModel {
  // The enterprise value at the regular session price, as `valuation` measures it: after the close, the close's.
  const fundamentals = financials ? atRegularSessionPrice(financials).fundamentals : undefined;
  const currency = fundamentals?.financialCurrency ?? financials?.financialCurrency ?? null;
  const enterpriseValue = reportedEnterpriseValue(fundamentals) ?? null;
  const check = enterpriseValueLabel(fundamentals) === "provider" ? enterpriseValueCheck(fundamentals) : undefined;
  const freeCashFlow = fundamentals?.freeCashFlow ?? null;
  const fcfMargin = options.fcfMargin ?? DEFAULT_FCF_MARGIN;
  const empty: ReverseDcfModel = { symbol: options.symbol, currency, discountRate: options.discountRate, terminalGrowth: TERMINAL_GROWTH,
    enterpriseValue, computedEnterpriseValue: check?.computed ?? null, enterpriseValueNote: check ? enterpriseValueReconciliationNote(fundamentals) ?? null : null,
    freeCashFlow, fcfYield: null, implied: null, fcfMargin, impliedRevenue: null,
    pastGrowth: financials ? pastFcfGrowth(financials) : null, sensitivity: [], error: null };
  const valueCurrency = fundamentals?.marketCapCurrency;
  // ADRs and cross-listings can report cash flows in one currency and trade in another.
  if (currency && valueCurrency && currency !== valueCurrency) {
    return { ...empty, error: `Cash flows are in ${currency} and the market value in ${valueCurrency}.` };
  }
  // A withdrawn EV is unavailable here as in `valuation`, which says why.
  if (enterpriseValueWithdrawn(fundamentals)) {
    return { ...empty, error: enterpriseValueReconciliationNote(fundamentals) ?? "Enterprise value unavailable." };
  }
  if (enterpriseValue == null || !(enterpriseValue > 0)) return { ...empty, error: "Enterprise value unavailable." };
  if (freeCashFlow == null) return { ...empty, error: "Free cash flow unavailable." };
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
