import { apiClient } from "../api-client";
import type { FundBondFacts } from "../api-client/fund-facts";
import type { HeadlessPaneEntry, HeadlessPaneOptionDef } from "../types/headless";
import { formatFundYield, NOT_SEC_YIELD } from "./bond-funds";
import { isUsListingExchange } from "../utils/exchanges";

/**
 * Tax-equivalent yield and the muni/Treasury ratio, for `fundamentals`,
 * `fn DVD`, `fn ETF` and `fn DES` with `--tax-rate`.
 *
 *   tax-equivalent yield = yield / (1 - (federal rate + state rate))
 *   muni/Treasury ratio  = yield / Treasury par yield at the tenor nearest the fund's duration
 *
 * The yield is the fund's 30-day SEC yield where its sponsor publishes one,
 * else its distribution yield, and the output says which. The federal rate is
 * `--tax-rate` (40.8 is the 37% top bracket plus the 3.8% net investment
 * income tax). The state rate counts only for a single-state municipal fund
 * of `--state`, whose income is exempt from that state's tax too; a national
 * fund's income is taxed by the state like a taxable bond's, so the state
 * rate cancels out. The two rates add up without netting a federal deduction
 * for state tax, which the SALT cap mostly removes: this is how iShares
 * computes the tax-equivalent yields it publishes (on 2026-10-15, MUB 4.0418% at
 * 40.8%: 6.83%; CMF 3.87% at 40.8% + 13.3% California: 8.43%). The ratio
 * compares pre-tax yields, the convention for muni/Treasury ratios.
 */
const TAX_EQUIVALENT_FORMULA = "tax-equivalent yield = yield / (1 - (federal rate + state rate)); the state rate counts only for a single-state muni fund of --state";
const MUNI_TREASURY_RATIO_FORMULA = "muni/Treasury ratio = yield / Treasury par yield at the GC tenor nearest the fund's duration";

export interface TaxRates {
  /** Percent: federal income tax plus the net investment income tax (40.8). */
  federal: number;
  /** A state's rate in percent and its two-letter code, applied to that state's single-state muni funds only. */
  state: { rate: number; code: string } | null;
}

/** The raw option values as typed: `--tax-rate 40.8 --state-rate 9.3 --state CA`. */
export interface TaxRateInput {
  taxRate?: unknown;
  stateRate?: unknown;
  state?: unknown;
}

function percentOption(value: unknown, flag: string): number {
  const text = String(value).trim().replace(/%$/, "");
  const rate = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(rate) || rate < 0 || rate >= 100) {
    throw new Error(`${flag} takes a rate in percent from 0 to under 100, such as 40.8 (37% federal + 3.8% NIIT).`);
  }
  return rate;
}

/** A tax rate option as typed: `40.8` or `40.8%`, kept as the number. */
function normalizeTaxRate(value: string): number {
  return percentOption(value, "--tax-rate");
}

/** A state code as typed: `ca`, `CA`. */
function normalizeStateCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error("--state takes a two-letter US state code, such as CA or NY.");
  return code;
}

/**
 * The rates `--tax-rate`, `--state-rate` and `--state` ask for; null without
 * `--tax-rate`. A state rate needs its state and the other way round, and the
 * two rates together stay under 100%.
 */
export function parseTaxRates(input: TaxRateInput): TaxRates | null {
  const has = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
  if (!has(input.taxRate)) {
    if (has(input.stateRate) || has(input.state)) throw new Error("--state-rate and --state go with --tax-rate, such as --tax-rate 40.8 --state-rate 9.3 --state CA.");
    return null;
  }
  const federal = percentOption(input.taxRate, "--tax-rate");
  if (has(input.stateRate) !== has(input.state)) {
    throw new Error("--state-rate and --state go together: the state rate counts only for a single-state muni fund of that state, such as --state-rate 9.3 --state CA.");
  }
  if (!has(input.stateRate)) return { federal, state: null };
  const rate = percentOption(input.stateRate, "--state-rate");
  if (federal + rate >= 100) throw new Error("--tax-rate and --state-rate together must stay under 100%.");
  return { federal, state: { rate, code: normalizeStateCode(String(input.state)) } };
}

/** The options as the catalog shows them: one fund's report, and a ranking of several with their tax columns. */
export const TAX_RATE_EXAMPLES = ["MUB --tax-rate 40.8", "CMF --tax-rate 40.8 --state-rate 13.3 --state CA", "MUB VTEB SUB LQD --tax-rate 40.8"] as const;

/** The options `fn DVD` takes for it; the pane does not draw them, the report adds its lines. */
export const TAX_RATE_OPTIONS: HeadlessPaneOptionDef[] = [
  {
    key: "tax-rate",
    type: "string",
    placeholder: "pct",
    description: `Federal tax rate in percent (40.8 = 37% + 3.8% NIIT): adds a muni fund's tax-equivalent yield and muni/Treasury ratio. ${TAX_EQUIVALENT_FORMULA}; ${MUNI_TREASURY_RATIO_FORMULA}.`,
    normalize: normalizeTaxRate,
    shot: { reportOnly: "adds the tax-equivalent yield and muni/Treasury ratio to the text report" },
  },
  {
    key: "state-rate",
    type: "string",
    placeholder: "pct",
    description: "State tax rate in percent, with --state: added to --tax-rate only for a single-state muni fund of that state (CMF, VTEC for CA; NYF, MUNY for NY).",
    normalize: (value) => percentOption(value, "--state-rate"),
    shot: { reportOnly: "adds the tax-equivalent yield and muni/Treasury ratio to the text report" },
  },
  {
    key: "state",
    type: "string",
    placeholder: "code",
    description: "Two-letter state of --state-rate, such as CA or NY.",
    normalize: normalizeStateCode,
    shot: { reportOnly: "adds the tax-equivalent yield and muni/Treasury ratio to the text report" },
  },
];

/**
 * The options as a pane that draws them takes them (`fn DES MUB --tax-rate
 * 40.8`): each is set as the pane setting of its key, which the overview
 * reads (taxRatesFromSettings).
 */
export const TAX_RATE_PANE_OPTIONS = TAX_RATE_OPTIONS.map(({ shot: _shot, normalize, ...option }) => ({
  ...option,
  ...option.key === "tax-rate" ? { example: "--tax-rate 40.8" } : {},
  ...normalize ? { normalize: (value: string) => String(normalize(value)) } : {},
}));

/**
 * The rates a pane's settings ask for (TAX_RATE_PANE_OPTIONS): null without a
 * tax rate, and the reason when they do not go together.
 */
export function taxRatesFromSettings(settings: Record<string, unknown> | undefined): { rates: TaxRates } | { error: string } | null {
  const value = (key: string) => {
    const raw = settings?.[key];
    return typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
  };
  try {
    const rates = parseTaxRates({ taxRate: value("tax-rate"), stateRate: value("state-rate"), state: value("state") });
    return rates ? { rates } : null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The same options in `gloom help fundamentals`. */
export const TAX_RATE_HELP_OPTIONS = [
  {
    flags: "--tax-rate <pct>",
    description: `For a muni bond fund: its tax-equivalent yield and muni/Treasury ratio at this federal rate (40.8 = 37% + 3.8% NIIT). ${TAX_EQUIVALENT_FORMULA}; ${MUNI_TREASURY_RATIO_FORMULA}`,
  },
  { flags: "--state-rate <pct>", description: "With --state: a state rate added to --tax-rate for a single-state muni fund of that state only" },
  { flags: "--state <code>", description: "The two-letter state of --state-rate, such as CA or NY" },
];

/** The yield a tax-equivalent yield is taken on: the SEC yield, or the distribution yield when the sponsor publishes none. */
export interface YieldBasis {
  kind: "sec" | "distribution";
  /** Percent. */
  value: number;
  asOf: string | null;
  /** `30-day SEC yield`, `distribution yield (forward, not SEC yield)`. */
  label: string;
}

/** A Treasury curve point: its tenor (`7Y`), years, par yield in percent and date. */
export interface TreasuryTenor {
  tenor: string;
  years: number;
  yield: number;
  asOf: string | null;
  /** The FRED series of the same constant-maturity yield (`DGS7`), null for a tenor FRED has none of. */
  seriesId?: string | null;
}

/** FRED's constant-maturity Treasury series by tenor: the same par yields the Treasury publishes, under a stable id. */
const TREASURY_SERIES: Readonly<Record<string, string>> = {
  "1M": "DGS1MO", "3M": "DGS3MO", "6M": "DGS6MO", "1Y": "DGS1", "2Y": "DGS2", "3Y": "DGS3",
  "5Y": "DGS5", "7Y": "DGS7", "10Y": "DGS10", "20Y": "DGS20", "30Y": "DGS30",
};

/** `DGS7` for the 7Y tenor (`7Y`, `7y`, `7 Yr`); null for a tenor FRED has no series of (2M, 4M). */
export function treasurySeriesId(tenor: string): string | null {
  const key = tenor.trim().toUpperCase().replace(/\s+/g, "").replace(/(?:YRS?|YEARS?)$/, "Y").replace(/(?:MOS?|MONTHS?)$/, "M");
  return TREASURY_SERIES[key] ?? null;
}

/**
 * The curve tenor nearest a duration in years, the shorter one on a tie:
 * MUB's 7.13 years is the 7-year. Null without a duration or a point.
 */
export function nearestTenor(points: readonly TreasuryTenor[], durationYears: number | null | undefined): TreasuryTenor | null {
  if (durationYears == null || !Number.isFinite(durationYears)) return null;
  let best: TreasuryTenor | null = null;
  for (const point of [...points].sort((a, b) => a.years - b.years)) {
    if (!Number.isFinite(point.yield)) continue;
    if (!best || Math.abs(point.years - durationYears) < Math.abs(best.years - durationYears)) best = point;
  }
  return best;
}

export function taxEquivalentYield(yieldPercent: number, combinedRatePercent: number): number {
  return yieldPercent / (1 - combinedRatePercent / 100);
}

export interface TaxEquivalentAnalysis {
  symbol: string;
  rates: TaxRates;
  /** A failed prerequisite check, distinct from a confirmed inapplicable fund. */
  checkError?: string;
  /** Why there is no tax-equivalent yield: the fund is not a muni fund, or nothing classes it. */
  notApplicable?: string;
  /** The rate the yield is grossed up by: federal, plus the state's for one of its own funds. */
  combinedRate?: number;
  stateApplied?: boolean;
  /** Why a state rate given was not added. */
  stateNote?: string;
  basis?: YieldBasis;
  /** Percent. */
  taxEquivalentYield?: number;
  ratio?: { value: number; treasury: TreasuryTenor; durationYears: number } | null;
  /** Why there is no ratio. */
  ratioNote?: string;
}

/** `40.8%`, `40.80%` read as `40.8%`. */
function formatRate(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

/**
 * A yield a formula is worked from, to the precision it was worked at, so the
 * line adds up from what it shows: MUB's SEC yield of 3.7955% over (1 -
 * 40.8%) is 6.41%, where `3.80%` would give 6.42%. Two decimals at least,
 * four at most.
 */
function formulaPercent(value: number): string {
  const text = value.toFixed(4).replace(/0{1,2}$/, "");
  return `${text}%`;
}

/** A muni/Treasury ratio as every view draws it: `80.8%`. */
export function formatMuniTreasuryRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Why `--tax-rate` has no bond fund figures to read for a listing, which it
 * says in place of the tax-equivalent yield: a stock or anything else that is
 * not a fund, or a fund listed outside the US, whose income US tax rates do
 * not describe.
 */
export type NoBondFigures = "not-a-fund" | "listed-abroad";

/** NoBondFigures for a listing of `kind` (resolveTickerInstrumentKind) on `exchange`; null for a fund listed in the US or on no known venue. */
export function noBondFigures(kind: string | null | undefined, exchange: string | null | undefined): NoBondFigures | null {
  if (kind !== "fund") return "not-a-fund";
  return exchange && !isUsListingExchange(exchange) ? "listed-abroad" : null;
}

/** `KO is not a fund`, or `--tax-rate does not apply to 3046, a fund listed outside the US`. */
function noBondFiguresText(symbol: string, reason: NoBondFigures): string {
  return reason === "not-a-fund" ? `${symbol} is not a fund` : `--tax-rate does not apply to ${symbol}, a fund listed outside the US`;
}

/**
 * A fund's tax-equivalent yield and muni/Treasury ratio from its bond facts,
 * the distribution yield it falls back to, and the Treasury curve. Only a
 * fund its sponsor classes as municipal has one; any other says why not, and
 * a listing that is not a US fund (`noBondFigures`) says so rather than that
 * its figures are not loaded.
 */
export function analyzeTaxEquivalent({
  symbol, bond, rates, distribution, treasury, checkError, noBondFigures: notFund,
}: {
  symbol: string;
  bond: FundBondFacts | null | undefined;
  rates: TaxRates;
  checkError?: string;
  /** Why the listing has no bond fund figures to read at all; absent for a US-listed fund. */
  noBondFigures?: NoBondFigures | null;
  /** The distribution yield in percent and its label, for a fund without a SEC yield. */
  distribution?: YieldBasis | null;
  /** The Treasury curve's points, or null when it could not be read. */
  treasury?: readonly TreasuryTenor[] | null;
}): TaxEquivalentAnalysis {
  if (checkError) return { symbol, rates, checkError };
  if (notFund) return { symbol, rates, notApplicable: `no tax-equivalent yield: ${noBondFiguresText(symbol, notFund)}` };
  if (!bond) {
    return { symbol, rates, notApplicable: `no tax-equivalent yield: no sponsor bond figures are loaded for ${symbol} (they are for iShares, Vanguard, SPDR and VanEck bond ETFs)` };
  }
  if (bond.kind !== "municipal") {
    return { symbol, rates, notApplicable: `no tax-equivalent yield: ${symbol} is a taxable bond fund, its income is taxed` };
  }
  const state = rates.state;
  const stateApplied = !!state && bond.state === state.code;
  const stateNote = !state ? undefined
    : stateApplied ? undefined
    : bond.state ? `--state-rate not added: ${symbol} is a ${bond.state} fund, not ${state.code}`
    : `--state-rate not added: ${symbol} is a national fund, its income is taxed by ${state.code}`;
  const combinedRate = rates.federal + (stateApplied ? state!.rate : 0);
  const basis: YieldBasis | null = bond.secYield
    ? { kind: "sec", value: bond.secYield.value, asOf: bond.secYield.asOf, label: "30-day SEC yield" }
    : distribution ?? null;
  if (!basis) {
    return { symbol, rates, combinedRate, stateApplied, ...(stateNote ? { stateNote } : {}),
      notApplicable: `no tax-equivalent yield: ${symbol} has neither a SEC yield nor a distribution yield` };
  }
  const durationYears = bond.duration?.value;
  const treasuryPoint = treasury ? nearestTenor(treasury, durationYears) : null;
  const ratioNote = durationYears == null ? `no ratio: no sponsor duration is loaded for ${symbol} to match a Treasury tenor`
    : !treasuryPoint ? "no ratio: the Treasury curve could not be read" : undefined;
  return {
    symbol,
    rates,
    combinedRate,
    stateApplied,
    ...(stateNote ? { stateNote } : {}),
    basis,
    taxEquivalentYield: taxEquivalentYield(basis.value, combinedRate),
    ratio: treasuryPoint && durationYears != null
      ? { value: basis.value / treasuryPoint.yield, treasury: treasuryPoint, durationYears } : null,
    ...(ratioNote ? { ratioNote } : {}),
  };
}

/** A short form of the basis for the ratio line: `SEC yield 4.0418%`, `distribution yield 3.27%`. */
function basisShort(basis: YieldBasis): string {
  return `${basis.kind === "sec" ? "SEC yield" : "distribution yield"} ${formulaPercent(basis.value)}`;
}

/** One report line: its label, its text, and the raw value JSON keeps. */
export interface TaxEquivalentLine {
  key: "taxRate" | "taxEquivalentYield" | "muniTreasuryRatio";
  label: string;
  text: string;
  value: number | null;
  unit?: string;
  /**
   * How an export writes it: the figure as drawn (`6.41%`) under the unit it
   * names (`pct`), dated by the yield it was taken on; the reason alone when
   * there is no figure.
   */
  export: { formatted: string; exportUnit?: string; asOf: string | null };
}

/** `6.41%` for an export, the figure alone; its reason when there is none. */
const exportPercent = (text: string, asOf: string | null) => ({ formatted: text, exportUnit: "pct", asOf });

/**
 * The analysis as report lines, each saying what it was computed from:
 *
 *   Tax rate              40.8% (federal; MUB is a national fund, no state rate)
 *   Tax-equivalent yield  6.83% (30-day SEC yield 4.0418% as of 2026-10-15 / (1 - 40.8%))
 *   Muni/Treasury ratio   81.0% (SEC yield 4.0418% / 7Y Treasury 4.99% on 2026-10-16, the tenor nearest its 7.13-year duration)
 *
 * Each yield in a formula is written as precisely as it was worked with
 * (formulaPercent), so the line adds up from what it shows.
 */
export function taxEquivalentLines(analysis: TaxEquivalentAnalysis): TaxEquivalentLine[] {
  if (analysis.checkError) {
    return [{ key: "taxEquivalentYield", label: "Tax-equivalent yield", text: analysis.checkError, value: null, export: { formatted: analysis.checkError, asOf: null } }];
  }
  const { rates } = analysis;
  const stateText = !rates.state ? (analysis.notApplicable ? "federal" : "federal; no state rate given")
    : analysis.stateApplied ? `federal ${formatRate(rates.federal)} + ${rates.state.code} ${formatRate(rates.state.rate)}`
    : `federal; ${analysis.stateNote}`;
  const combined = analysis.combinedRate ?? rates.federal;
  const lines: TaxEquivalentLine[] = [
    { key: "taxRate", label: "Tax rate", text: `${formatRate(combined)} (${stateText})`, value: combined, unit: "%", export: exportPercent(formatRate(combined), null) },
  ];
  if (analysis.notApplicable || !analysis.basis || analysis.taxEquivalentYield == null) {
    const reason = analysis.notApplicable ?? "—";
    lines.push({ key: "taxEquivalentYield", label: "Tax-equivalent yield", text: reason, value: null, export: { formatted: reason, asOf: null } });
    return lines;
  }
  const basis = analysis.basis;
  lines.push({
    key: "taxEquivalentYield",
    label: "Tax-equivalent yield",
    text: `${formatFundYield(analysis.taxEquivalentYield)} (${basis.label} ${formulaPercent(basis.value)}${basis.asOf ? ` as of ${basis.asOf}` : ""} / (1 - ${formatRate(combined)}))`,
    value: Math.round(analysis.taxEquivalentYield * 10_000) / 10_000,
    unit: "%",
    export: exportPercent(formatFundYield(analysis.taxEquivalentYield), basis.asOf),
  });
  const ratio = analysis.ratio;
  // The ratio is as old as the older of the two yields it divides.
  const ratioAsOf = ratio ? [basis.asOf, ratio.treasury.asOf].filter((day): day is string => !!day).sort()[0] ?? null : null;
  const ratioText = ratio ? formatMuniTreasuryRatio(ratio.value) : null;
  lines.push(ratio && ratioText
    ? {
      key: "muniTreasuryRatio",
      label: "Muni/Treasury ratio",
      text: `${ratioText} (${basisShort(basis)} / ${ratio.treasury.tenor} Treasury ${formulaPercent(ratio.treasury.yield)}`
        + `${ratio.treasury.asOf ? ` on ${ratio.treasury.asOf}` : ""}, the tenor nearest its ${ratio.durationYears.toFixed(2)}-year duration)`,
      value: Math.round(ratio.value * 10_000) / 10_000,
      export: exportPercent(ratioText, ratioAsOf),
    }
    : { key: "muniTreasuryRatio", label: "Muni/Treasury ratio", text: analysis.ratioNote ?? "—", value: null, export: { formatted: analysis.ratioNote ?? "—", asOf: null } });
  return lines;
}

/**
 * The report section every function with `--tax-rate` shows (DVD, ETF,
 * fundamentals): the text report's lines with their formulas, and the
 * figures an export keeps, each a number in its unit dated by the yield it
 * was taken on.
 */
export function taxEquivalentSection(analysis: TaxEquivalentAnalysis): { title: string; entries: HeadlessPaneEntry[]; textEntries: HeadlessPaneEntry[] } {
  const lines = taxEquivalentLines(analysis);
  return {
    title: "Tax-equivalent yield",
    textEntries: lines.map((line) => ({ label: line.label, value: line.value, formatted: line.text })),
    entries: lines.map((line) => ({ label: line.label, value: line.value, ...line.export })),
  };
}

/** The analysis as JSON keeps it: the rates, the yield it was taken on, the results and the formulas, without the text. */
export function taxEquivalentJson(tax: TaxEquivalentAnalysis) {
  return {
    federalRate: tax.rates.federal,
    stateRate: tax.rates.state ? { ...tax.rates.state, applied: tax.stateApplied === true } : null,
    combinedRate: tax.combinedRate ?? tax.rates.federal,
    basis: tax.basis ?? null,
    taxEquivalentYield: tax.taxEquivalentYield ?? null,
    muniTreasuryRatio: tax.ratio ? {
      value: tax.ratio.value, tenor: tax.ratio.treasury.tenor,
      // The constant-maturity series the tenor's yield is (DGS7), to read its history by.
      seriesId: tax.ratio.treasury.seriesId ?? treasurySeriesId(tax.ratio.treasury.tenor),
      treasuryYield: tax.ratio.treasury.yield, treasuryAsOf: tax.ratio.treasury.asOf, durationYears: tax.ratio.durationYears,
    } : null,
    ...(tax.checkError ? { checkError: tax.checkError } : {}),
    notes: [tax.checkError, tax.notApplicable, tax.stateNote, tax.ratioNote].filter((note): note is string => !!note),
    formula: TAX_EQUIVALENT_FORMULA,
    ratioFormula: MUNI_TREASURY_RATIO_FORMULA,
  };
}

/** The distribution yield a report falls back to, labelled as not the SEC yield. */
export function distributionBasis(fraction: number | null | undefined, which: "forward" | "trailing", asOf: string | null = null): YieldBasis | null {
  return fraction != null && Number.isFinite(fraction)
    ? { kind: "distribution", value: fraction * 100, asOf, label: `${which} distribution yield (${NOT_SEC_YIELD})` }
    : null;
}

/**
 * The US Treasury par curve GC shows, as tenors: its latest stored session,
 * or, when that cannot be read, FRED's constant-maturity curve, as GC falls
 * back to. Null when neither can be read, which leaves the ratio out with a
 * note.
 */
export async function loadTreasuryTenors(
  client: Pick<typeof apiClient, "getCloudCurve" | "getCloudYieldCurve"> = apiClient,
): Promise<TreasuryTenor[] | null> {
  const finite = (points: TreasuryTenor[]) => {
    const kept = points.filter((point) => Number.isFinite(point.yield) && Number.isFinite(point.years));
    return kept.length > 0 ? kept : null;
  };
  try {
    const view = await client.getCloudCurve("us", null);
    return finite(view.points.flatMap((point) => point.yield == null ? []
      : [{ tenor: point.tenor, years: point.years, yield: point.yield, asOf: view.asOf ?? null, seriesId: treasurySeriesId(point.tenor) }]));
  } catch {
    try {
      return finite((await client.getCloudYieldCurve()).flatMap((point) => point.yield == null ? []
        : [{ tenor: point.maturity, years: point.maturityYears, yield: point.yield, asOf: point.asOf ?? null, seriesId: treasurySeriesId(point.maturity) }]));
    } catch {
      // Intentional ignore: the ratio line then says the Treasury curve could not be read.
      return null;
    }
  }
}
