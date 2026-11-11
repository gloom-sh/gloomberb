import { unavailableText } from "../../../components/ui/status";
import { atRegularSessionPrice } from "../../../market-data/quotes/regular-session-valuation";
import type { FinancialStatement, Fundamentals, TickerFinancials } from "../../../types/financials";
import { cashAndShortTermInvestments } from "../../../utils/cash-runway";
import { formatShortDate } from "../../../utils/datetime-format";
import { fiscalPeriodLabel, fiscalYearEndMonth } from "../../../utils/fiscal-period";
import { formatCompact, formatCompactCurrency } from "../../../utils/format";
import { BANK_ENTERPRISE_VALUE, enterpriseValueCheck, enterpriseValueComputed, enterpriseValueNotMeaningful, enterpriseValueReconciliationNote,
  enterpriseValueWithdrawn, reportedEnterpriseValue, withBankEnterpriseValue } from "../../../utils/fundamentals";
import { debtAndLeases, leaseBasis } from "../../../utils/lease-liabilities";

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

/**
 * An input the model cannot run without that the data does not give: what is
 * missing of it ("total debt on the Jun 30, 2026 balance sheet") and the
 * statement that shows what there is. A limit of the data, not a failure.
 */
export interface MissingInput {
  input: "enterpriseValue" | "freeCashFlow";
  needs: string;
  statement: "balance" | "cashflow";
}

/** A solved growth rate, or which side of the searched range the price lies on. */
export type ImpliedGrowth = { kind: "rate"; value: number } | { kind: "below" } | { kind: "above" };

export interface ReverseDcfModel {
  symbol: string;
  currency: string | null;
  discountRate: number;
  terminalGrowth: number;
  /** The enterprise value `valuation` shows, at the regular session price (reportedEnterpriseValue). */
  enterpriseValue: number | null;
  /** The line `valuation` prints under a computed EV: its inputs. */
  enterpriseValueNote: string | null;
  /**
   * The EV is market cap + debt - cash from this balance sheet, the source's
   * figure being withdrawn: "Jun 30, 2026". Null for the EV `valuation` shows.
   */
  enterpriseValueSheet: string | null;
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
  /** The inputs the data does not give, so nothing is implied; empty when the model ran or failed for another reason. */
  missing: MissingInput[];
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

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A balance sheet's day as the reports write a date: "Jun 30, 2026". */
const sheetDay = (date: string) => formatShortDate(`${date.slice(0, 10)}T00:00:00Z`, { utc: true, fallback: date.slice(0, 10) });

/** "total debt and cash", "total debt": the lines a bridge lacks, in a sentence. */
const listed = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

type BalanceSheetBridge = { value: number; sheet: string; note: string } | { missing: MissingInput };

/**
 * The EV in place of a withdrawn source figure: market cap + total debt (+
 * leases, as FA's net debt counts them) - cash and short-term investments +
 * minority interest and preferred equity on the latest balance sheet. The
 * bridge Gloom Cloud computed beside the withdrawal where it served one (at
 * the balance sheet date's rate); else the latest balance sheet here, a
 * sheet in another currency than the market cap converted at the rate the
 * trailing figures state. A line the sheet does not report is named, never
 * taken as zero.
 */
function balanceSheetBridge(financials: TickerFinancials, fundamentals: Fundamentals): BalanceSheetBridge {
  const currency = fundamentals.marketCapCurrency;
  const check = enterpriseValueCheck(fundamentals);
  const minorityOf = (value: number | undefined) => finite(value) && value > 0 ? value : 0;
  if (check?.status === "withdrawn" && finite(check.computed) && check.currency === currency && check.balanceSheetDate) {
    const minority = minorityOf(check.minorityAndPreferred);
    const fx = check.fx && finite(check.fx.rate) ? `, ${check.fx.from} at ${check.fx.rate.toPrecision(4)} ${check.currency}` : "";
    const value = check.computed + minority;
    return { value, sheet: sheetDay(check.balanceSheetDate), note: bridgeNote({ value, currency: check.currency!, marketCap: check.marketCap,
      totalDebt: check.totalDebt, leases: check.leases, cash: check.cash, minority, date: check.balanceSheetDate, fx }) };
  }
  const today = new Date().toISOString().slice(0, 10);
  const sheets = [...financials.quarterlyStatements, ...financials.annualStatements]
    .filter((row) => /^\d{4}-\d{2}-\d{2}/.test(row.date) && row.date.slice(0, 10) <= today)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = sheets.find((row) => finite(row.totalDebt) || finite(row.capitalLeaseObligations) || cashAndShortTermInvestments(row) != null);
  if (!latest) return { missing: { input: "enterpriseValue", needs: "a balance sheet with debt and cash", statement: "balance" } };
  const day = sheetDay(latest.date);
  const basis = leaseBasis(sheets);
  const debt = basis === "included" ? debtAndLeases(latest) : finite(latest.totalDebt) ? { totalDebt: latest.totalDebt, leases: 0 } : undefined;
  const cash = cashAndShortTermInvestments(latest)?.amount;
  const absent = [
    ...!debt ? [finite(latest.totalDebt) ? "lease liabilities" : "total debt"] : [],
    ...cash == null ? ["cash"] : [],
  ];
  if (absent.length) return { missing: { input: "enterpriseValue", needs: `${listed(absent)} on the ${day} balance sheet`, statement: "balance" } };
  const marketCap = fundamentals.marketCap;
  if (!finite(marketCap) || !(marketCap > 0) || !currency) {
    return { missing: { input: "enterpriseValue", needs: "a market cap", statement: "balance" } };
  }
  const from = latest.currency ?? currency;
  const conversion = fundamentals.ttmConversion;
  const rate = from === currency ? 1 : conversion?.from === from && finite(conversion.rate) && conversion.rate > 0 ? conversion.rate : null;
  if (rate == null) {
    return { missing: { input: "enterpriseValue", needs: `a ${from} to ${currency} rate for the ${day} balance sheet`, statement: "balance" } };
  }
  const minority = minorityOf(minorityAndPreferredEquity(latest));
  const value = marketCap + (debt!.totalDebt + debt!.leases - cash! + minority) * rate;
  const fx = rate === 1 ? "" : `, ${from} at ${rate.toPrecision(4)} ${currency}${conversion?.asOf ? ` as of ${conversion.asOf.slice(0, 10)}` : ""}`;
  return { value, sheet: day, note: bridgeNote({ value, currency, marketCap, totalDebt: debt!.totalDebt * rate, leases: debt!.leases * rate,
    cash: cash! * rate, minority: minority * rate, date: latest.date.slice(0, 10), fx }) };
}

/** Total equity including minority interest less common equity: minority interest and preferred equity, where both lines are there. */
function minorityAndPreferredEquity(row: FinancialStatement): number | undefined {
  const gross = row.totalEquityGrossMinorityInterest;
  const common = row.commonStockEquity;
  return finite(gross) && finite(common) && gross - common > 0 ? gross - common : undefined;
}

/** "EV 183.5B HKD is market cap 195.3B + total debt 0 + leases 4.4B - cash and short-term investments 16.4B (balance sheet 2026-06-30, CNY at 1.174 HKD as of 2026-11-11)." */
function bridgeNote(input: { value: number; currency: string; marketCap?: number; totalDebt?: number; leases?: number; cash?: number;
  minority: number; date: string; fx: string }): string {
  const part = (label: string, value: number | undefined) => finite(value) ? `${label} ${formatCompact(value)}` : label;
  const leases = finite(input.leases) && input.leases > 0 ? ` + ${part("leases", input.leases)}` : "";
  const minority = input.minority > 0 ? ` + ${part("minority interest and preferred equity", input.minority)}` : "";
  return `EV ${formatCompact(input.value)} ${input.currency} is ${part("market cap", input.marketCap)} + ${part("total debt", input.totalDebt)}${leases}`
    + ` - ${part("cash and short-term investments", input.cash)}${minority} (balance sheet ${input.date}${input.fx}), the source's EV being withdrawn.`;
}

/** "the latest cash flow statement is FY2024": where the statements' free cash flow stops, for a model without a trailing one. */
function latestCashFlowPeriod(financials: TickerFinancials): string | null {
  const month = fiscalYearEndMonth(financials.annualStatements);
  const withFlow = (rows: readonly FinancialStatement[]) => rows.filter((row) => finite(row.freeCashFlow) || finite(row.operatingCashFlow))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const annual = withFlow(financials.annualStatements);
  const interim = withFlow(financials.quarterlyStatements);
  if (interim && (!annual || interim.date > annual.date)) return fiscalPeriodLabel(interim.date, "quarterly", month);
  return annual ? fiscalPeriodLabel(annual.date, "annual", month) : null;
}

export function projectReverseDcf(
  financials: TickerFinancials | null,
  /** `fcfMargin` is the margin the reader chose; without one the company's own trailing margin applies. */
  options: { symbol: string; discountRate: number; fcfMargin?: number },
): ReverseDcfModel {
  // The enterprise value at the regular session price, as `valuation` measures it: after the close, the close's.
  // A bank's reads n/m: its deposits are funding, not debt, so no growth rate prices an EV of it.
  const fundamentals = financials
    ? atRegularSessionPrice({ ...financials, fundamentals: withBankEnterpriseValue(financials.fundamentals, financials.profile) }).fundamentals
    : undefined;
  const currency = fundamentals?.financialCurrency ?? financials?.financialCurrency ?? null;
  // Market cap + debt - cash in place of a provider EV more than 5% from it, with its inputs in a note, as every view reads it.
  const computed = enterpriseValueComputed(fundamentals);
  const freeCashFlow = fundamentals?.freeCashFlow ?? null;
  const company = trailingFcfMargin(fundamentals);
  const fcfMargin = options.fcfMargin ?? company.margin ?? DEFAULT_FCF_MARGIN;
  const fcfMarginBasis: FcfMarginBasis = { company: company.margin, gap: company.gap,
    source: options.fcfMargin != null ? "chosen" : company.margin != null ? "company" : "default" };
  // A withdrawn source EV gives way to market cap + debt - cash on the latest balance sheet, labelled with its date.
  const bridge = financials && fundamentals && enterpriseValueWithdrawn(fundamentals) ? balanceSheetBridge(financials, fundamentals) : null;
  const bridged = bridge && "value" in bridge ? bridge : null;
  const enterpriseValue = bridged ? bridged.value : reportedEnterpriseValue(fundamentals) ?? null;
  const empty: ReverseDcfModel = { symbol: options.symbol, currency, discountRate: options.discountRate, terminalGrowth: TERMINAL_GROWTH,
    enterpriseValue, enterpriseValueNote: bridged ? bridged.note : computed ? enterpriseValueReconciliationNote(fundamentals) ?? null : null,
    enterpriseValueSheet: bridged?.sheet ?? null,
    freeCashFlow, fcfYield: null, implied: null, fcfMargin, fcfMarginBasis, impliedRevenue: null,
    pastGrowth: financials ? pastFcfGrowth(financials) : null, fiscalYearFcf: financials ? latestFiscalYearFcf(financials) : null,
    sensitivity: [], missing: [], error: null };
  const valueCurrency = fundamentals?.marketCapCurrency;
  // ADRs and cross-listings can report cash flows in one currency and trade in another.
  if (currency && valueCurrency && currency !== valueCurrency) {
    return { ...empty, error: `Cash flows are in ${currency} and the market value in ${valueCurrency}.` };
  }
  // An EV at or below zero is N/M here as in `valuation` and RV, with the same reason: no growth rate prices it.
  if (enterpriseValueNotMeaningful(fundamentals)) {
    return { ...empty, enterpriseValue: null, error: enterpriseValueReconciliationNote(fundamentals) ?? `EV ${BANK_ENTERPRISE_VALUE}.` };
  }
  if (bridged && !(bridged.value > 0)) {
    return { ...empty, enterpriseValue: null, error: "EV N/M: cash and short-term investments exceed market cap + total debt on the latest balance sheet." };
  }
  // What the data does not give is named with where to look, not reported as a failure.
  const missing: MissingInput[] = [
    ...bridge && "missing" in bridge ? [bridge.missing] : [],
    ...freeCashFlow == null && financials ? [{ input: "freeCashFlow" as const, statement: "cashflow" as const,
      needs: (() => { const latest = latestCashFlowPeriod(financials); return latest ? `a trailing figure; the latest cash flow statement is ${latest}` : "a trailing figure"; })() }] : [],
  ];
  if (missing.length) return { ...empty, enterpriseValue: bridged ? enterpriseValue : null, missing };
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

/**
 * "Inputs on file: fn FA 9992:HKEX --statement balance; fn FA 9992:HKEX
 * --statement cashflow": where to read what the statements hold of the
 * inputs the model lacks. Null when it lacks none.
 */
export function missingInputsNote(missing: readonly MissingInput[], symbol: string): string | null {
  if (!missing.length) return null;
  return `Inputs on file: ${[...new Set(missing.map((item) => `fn FA ${symbol} --statement ${item.statement}`))].join("; ")}`;
}
