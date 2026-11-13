import { unavailableText } from "../../../components/ui/status";
import { balanceSheetDay, enterpriseValueBridgeNote, listingEnterpriseValue } from "../../../market-data/quotes/listing-enterprise-value";
import { atRegularSessionPrice } from "../../../market-data/quotes/regular-session-valuation";
import type { FinancialStatement, Fundamentals, TickerFinancials } from "../../../types/financials";
import { exchangeResultsSource, type ExchangeResults } from "../../../utils/exchange-results";
import { reportsHalfYearly } from "../../../utils/financial-statements";
import { fiscalPeriodLabel, fiscalYearEndMonth, statementPeriodLabel, ttmPeriodLabel } from "../../../utils/fiscal-period";
import { displayTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";
import { formatCompactCurrency } from "../../../utils/format";
import { enterpriseValueComputed, enterpriseValueReconciliationNote, isFinancialEnterpriseValueReason, withFinancialEnterpriseValue } from "../../../utils/fundamentals";

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
  /** Free cash flow over the last twelve months, or, for a half-yearly reporter without one, the latest fiscal year's (freeCashFlowBasis). */
  freeCashFlow: number | null;
  /**
   * Where `freeCashFlow` is from when the trailing block serves none: the twelve months Gloom Cloud built from the year
   * and the half since it (`TTM H1 FY26`), or, for a half-yearly reporter without them, the latest fiscal year's
   * (`FY2025`). `note` says so with its figures. Null for the trailing block's own figure.
   */
  freeCashFlowBasis: { kind: "trailing" | "fiscal-year"; label: string; note: string } | null;
  fcfYield: number | null;
  implied: ImpliedGrowth | null;
  /** The margin `impliedRevenue` assumes. */
  fcfMargin: number;
  fcfMarginBasis: FcfMarginBasis;
  /** Year-ten revenue at `fcfMargin`: trailing free cash flow grown at the implied rate for ten years, over the margin. */
  impliedRevenue: number | null;
  /** Annual FCF growth between the latest annual statement and one up to five years earlier, when both are positive. `period` names the two years: FY2021–FY2025. */
  pastGrowth: { rate: number; years: number; period: string } | null;
  /** The latest annual statement's free cash flow in `currency`, which the past growth ends at, and the year it is of (FY2025). */
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

/** The latest fiscal year's free cash flow in the model's currency (statementInCurrency); null where it cannot be put in it. */
function latestFiscalYearFcf(
  financials: TickerFinancials,
  fundamentals: Pick<Fundamentals, "ttmConversion"> | undefined,
  currency: string | null,
): (NonNullable<ReverseDcfModel["fiscalYearFcf"]> & { stated: number; from: string; rate: number | null }) | null {
  const last = annualFreeCashFlows(financials).at(-1);
  const converted = last ? statementInCurrency(last.freeCashFlow!, last.currency ?? financials.financialCurrency, fundamentals, currency) : null;
  return last && converted ? { value: converted.value, stated: last.freeCashFlow!, from: converted.from, rate: converted.rate,
    label: fiscalPeriodLabel(last.date, "annual", fiscalYearEndMonth(financials.annualStatements)) } : null;
}

function fiscalYearFcfOf(...args: Parameters<typeof latestFiscalYearFcf>): ReverseDcfModel["fiscalYearFcf"] {
  const year = latestFiscalYearFcf(...args);
  return year ? { value: year.value, label: year.label } : null;
}

/**
 * A statement figure in the model's currency: as stated where the statement is in it (or states none), else at the
 * rate the trailing block converts at (Pop Mart's CNY statements under its HKD trailing figures). Null where neither applies.
 */
function statementInCurrency(
  value: number,
  stated: string | undefined,
  fundamentals: Pick<Fundamentals, "ttmConversion"> | undefined,
  currency: string | null,
): { value: number; from: string; rate: number | null } | null {
  // A statement that states no currency is read in the trailing block's, as the statements tables read it.
  const to = currency?.trim().toUpperCase(), from = stated?.trim().toUpperCase() || to;
  if (!from || !to) return null;
  if (from === to) return { value, from, rate: null };
  const conversion = fundamentals?.ttmConversion;
  return conversion?.from?.trim().toUpperCase() === from && finite(conversion.rate) && conversion.rate > 0
    ? { value: value * conversion.rate, from, rate: conversion.rate } : null;
}

/** "7B CNY at CNY/HKD 1.1740, 8.22B HKD": a figure and its conversion; the figure alone where none was needed. */
function convertedText(stated: number, value: number, from: string, rate: number | null, currency: string): string {
  return rate == null ? formatCompactCurrency(value, currency)
    : `${formatCompactCurrency(stated, from)}, ${formatCompactCurrency(value, currency)} at ${from}/${currency} ${rate.toFixed(4)}`;
}

/**
 * The free cash flow the growth is priced from where the trailing block serves none. A half-yearly reporter's twelve
 * months come from the statement Gloom Cloud built from the latest year and the half since it (`TTM H1 FY26`); without
 * one, its latest fiscal year's figure stands in, named as that year's (`FY2025`), as its next trailing figure is half a
 * year away; never an older year's. A quarterly reporter's missing trailing figure stays missing.
 */
function fallbackFreeCashFlow(
  financials: TickerFinancials,
  fundamentals: Pick<Fundamentals, "ttmConversion"> | undefined,
  currency: string | null,
  symbol: string,
): { value: number; basis: NonNullable<ReverseDcfModel["freeCashFlowBasis"]> } | null {
  const month = fiscalYearEndMonth(financials.annualStatements);
  const trailing = financials.trailingStatement;
  if (trailing && finite(trailing.freeCashFlow) && currency) {
    const converted = statementInCurrency(trailing.freeCashFlow, trailing.currency ?? financials.financialCurrency, fundamentals, currency);
    if (converted) {
      const label = ttmPeriodLabel(trailing.trailing.interim.end, month, trailing.trailing.interim.months);
      return { value: converted.value, basis: { kind: "trailing", label,
        note: `Free cash flow ${label} is ${convertedText(trailing.freeCashFlow, converted.value, converted.from, converted.rate, currency)}:`
          + ` ${trailing.trailing.basis}.` } };
    }
  }
  // By its venue's code: a listing saved under its MIC (BHP:XASX) is ASX's.
  const exchange = parsePublicTickerKey(displayTickerKey(symbol)).exchange;
  if (!currency || !reportsHalfYearly(exchange, financials.quarterlyStatements, financials.annualStatements)) return null;
  const year = latestFiscalYearFcf(financials, fundamentals, currency);
  const latestYear = financials.annualStatements.reduce<string>((max, row) => row.date > max ? row.date : max, "");
  if (!year || annualFreeCashFlows(financials).at(-1)?.date !== latestYear) return null;
  return { value: year.value, basis: { kind: "fiscal-year", label: year.label,
    note: `Free cash flow is ${year.label}'s, ${convertedText(year.stated, year.value, year.from, year.rate, currency)}:`
      + ` the company reports half-yearly and no trailing twelve months are served.` } };
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

/** "FY2024" and its date: where the statements' free cash flow stops, for a model without a trailing one. */
function latestCashFlowPeriod(financials: TickerFinancials): { label: string; date: string } | null {
  const month = fiscalYearEndMonth(financials.annualStatements);
  const withFlow = (rows: readonly FinancialStatement[]) => rows.filter((row) => finite(row.freeCashFlow) || finite(row.operatingCashFlow))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const annual = withFlow(financials.annualStatements);
  const interim = withFlow(financials.quarterlyStatements);
  // A half filled into the quarterly list is H1 FY26, as FA's column names it.
  if (interim && (!annual || interim.date > annual.date)) return { label: statementPeriodLabel(interim, "quarterly", month), date: interim.date.slice(0, 10) };
  return annual ? { label: fiscalPeriodLabel(annual.date, "annual", month), date: annual.date.slice(0, 10) } : null;
}

export function projectReverseDcf(
  financials: TickerFinancials | null,
  /**
   * `fcfMargin` is the margin the reader chose; without one the company's own trailing margin applies. `exchangeResults`:
   * an HKEX company's results announcements, which date the EV's balance sheet and say where a missing FCF is published.
   */
  options: { symbol: string; discountRate: number; fcfMargin?: number; exchangeResults?: ExchangeResults | null },
): ReverseDcfModel {
  // The enterprise value at the regular session price, as `valuation` measures it: after the close, the close's.
  // A bank's reads n/m: its deposits are funding, not debt, so no growth rate prices an EV of it.
  const fundamentals = financials
    ? atRegularSessionPrice({ ...financials, fundamentals: withFinancialEnterpriseValue(financials.fundamentals, financials.profile) }).fundamentals
    : undefined;
  const currency = fundamentals?.financialCurrency ?? financials?.financialCurrency ?? null;
  const fallback = financials && !finite(fundamentals?.freeCashFlow) ? fallbackFreeCashFlow(financials, fundamentals, currency, options.symbol) : null;
  const freeCashFlow = fundamentals?.freeCashFlow ?? fallback?.value ?? null;
  // A trailing figure from the year and the half is the company's TTM FCF; a fiscal year's is not, so its margin is not taken.
  const company = trailingFcfMargin(fallback?.basis.kind === "trailing" ? { ...fundamentals, freeCashFlow: fallback.value } : fundamentals);
  const fcfMargin = options.fcfMargin ?? company.margin ?? DEFAULT_FCF_MARGIN;
  const fcfMarginBasis: FcfMarginBasis = { company: company.margin, gap: company.gap,
    source: options.fcfMargin != null ? "chosen" : company.margin != null ? "company" : "default" };
  // The EV `fundamentals` and RV show (listingEnterpriseValue): the served one, or in place of a withdrawn one, market cap +
  // debt - cash on the latest balance sheet, labelled with its date and its inputs in a note.
  const listing = financials ? listingEnterpriseValue(financials) : { kind: "unavailable" as const };
  const value = listing.kind === "value" ? listing : null;
  const bridge = value?.basis === "computed" ? value.bridge ?? null : null;
  // Where the balance sheet's figures were first published: "interim results announced 2026-08-20 (HKEXnews)".
  const published = bridge ? exchangeResultsSource(options.exchangeResults, bridge.sheetDate) : null;
  const bridgeNote = value && bridge ? enterpriseValueBridgeNote(value) : null;
  const enterpriseValueNote = bridgeNote ? `${bridgeNote}${published ? ` Balance sheet from the ${published}.` : ""}`
    : value && enterpriseValueComputed(fundamentals) ? enterpriseValueReconciliationNote(fundamentals, undefined, financials ?? undefined) ?? null : null;
  const enterpriseValue = value?.value ?? null;
  const empty: ReverseDcfModel = { symbol: options.symbol, currency, discountRate: options.discountRate, terminalGrowth: TERMINAL_GROWTH,
    enterpriseValue, enterpriseValueNote, enterpriseValueSheet: bridge ? balanceSheetDay(bridge.sheetDate) : null,
    freeCashFlow, freeCashFlowBasis: fallback?.basis ?? null, fcfYield: null, implied: null, fcfMargin, fcfMarginBasis, impliedRevenue: null,
    pastGrowth: financials ? pastFcfGrowth(financials) : null, fiscalYearFcf: financials ? fiscalYearFcfOf(financials, fundamentals, currency) : null,
    sensitivity: [], missing: [], error: null };
  const valueCurrency = fundamentals?.marketCapCurrency;
  // ADRs and cross-listings can report cash flows in one currency and trade in another.
  if (currency && valueCurrency && currency !== valueCurrency) {
    return { ...empty, error: `Cash flows are in ${currency} and the market value in ${valueCurrency}.` };
  }
  // An EV at or below zero is N/M here as in `valuation` and RV, with the same reason: no growth rate prices it.
  if (listing.kind === "not-meaningful") {
    const reason = isFinancialEnterpriseValueReason(listing.reason) ? null : `EV N/M: ${listing.reason.charAt(0).toLowerCase()}${listing.reason.slice(1)}.`;
    return { ...empty, enterpriseValue: null, error: enterpriseValueReconciliationNote(fundamentals) ?? reason ?? `EV ${listing.reason}.` };
  }
  // What the data does not give is named with where to look, not reported as a failure. An EV that is there is shown beside a missing FCF.
  const missing: MissingInput[] = [
    ...listing.kind === "unavailable" && listing.needs ? [{ input: "enterpriseValue" as const, needs: listing.needs, statement: "balance" as const }] : [],
    ...freeCashFlow == null && financials ? [{ input: "freeCashFlow" as const, statement: "cashflow" as const,
      needs: missingFreeCashFlow(financials, options.exchangeResults) }] : [],
  ];
  if (missing.length) return { ...empty, missing };
  if (enterpriseValue == null || !(enterpriseValue > 0)) return { ...empty, error: unavailableText("Enterprise value") };
  if (freeCashFlow == null) return { ...empty, error: unavailableText("Free cash flow") };
  if (!(freeCashFlow > 0)) {
    const span = fallback?.basis.kind === "fiscal-year" ? `in ${fallback.basis.label}` : "over the last twelve months";
    return { ...empty, error: `Free cash flow ${span} is negative, so no growth rate prices it.` };
  }
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
 * What a missing trailing FCF needs, and where its next figures are: "a trailing figure; the latest cash flow statement
 * is FY2024, and the half year to 2026-06-30 is in the interim results announced 2026-08-20 (HKEXnews), its statements
 * not in yet".
 */
function missingFreeCashFlow(financials: TickerFinancials, exchangeResults: ExchangeResults | null | undefined): string {
  const latest = latestCashFlowPeriod(financials);
  const parts = latest ? [`the latest cash flow statement is ${latest.label}`] : [];
  const results = exchangeResults?.latest;
  const newer = exchangeResults?.newer.find((item) => item.kind !== "business update");
  if (results && results.kind !== "business update" && (!latest || results.date > latest.date)) {
    parts.push(`the ${RESULTS_SPAN[results.kind]} to ${results.date} is in the ${results.kind} announced ${results.announced} (${exchangeResults!.publisher}), its statements not in yet`);
  } else if (newer && newer.kind !== "business update") {
    parts.push(`newer figures are in the ${newer.kind} announced ${newer.announced} (${exchangeResults!.publisher}), their statements not in yet`);
  }
  return parts.length ? `a trailing figure; ${parts.join(", and ")}` : "a trailing figure";
}

const RESULTS_SPAN = { "annual results": "year", "interim results": "half year", "quarterly results": "quarter" } as const;

/**
 * "Inputs on file: fn FA 9992:HKEX --statement balance; fn FA 9992:HKEX
 * --statement cashflow": where to read what the statements hold of the
 * inputs the model lacks. Null when it lacks none.
 */
export function missingInputsNote(missing: readonly MissingInput[], symbol: string): string | null {
  if (!missing.length) return null;
  return `Inputs on file: ${[...new Set(missing.map((item) => `fn FA ${symbol} --statement ${item.statement}`))].join("; ")}`;
}
