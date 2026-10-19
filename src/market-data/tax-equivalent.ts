import { apiClient } from "../api-client";
import type { FundBondFacts } from "../api-client/fund-facts";
import type { HeadlessPaneOptionDef } from "../types/headless";
import { formatFundYield, NOT_SEC_YIELD } from "./bond-funds";

/**
 * Tax-equivalent yield and the muni/Treasury ratio, for `fundamentals` and
 * `fn DVD` with `--tax-rate`.
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
 * computes the tax-equivalent yields it publishes (MUB 4.04% at 40.8%: 6.83%;
 * CMF 3.87% at 40.8% + 13.3% California: 8.43%). The ratio compares pre-tax
 * yields, the convention for muni/Treasury ratios.
 */
export const TAX_EQUIVALENT_FORMULA = "tax-equivalent yield = yield / (1 - (federal rate + state rate)); the state rate counts only for a single-state muni fund of --state";
export const MUNI_TREASURY_RATIO_FORMULA = "muni/Treasury ratio = yield / Treasury par yield at the GC tenor nearest the fund's duration";

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
export function normalizeTaxRate(value: string): number {
  return percentOption(value, "--tax-rate");
}

/** A state code as typed: `ca`, `CA`. */
export function normalizeStateCode(value: string): string {
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

/** One fund with the options, as the catalog shows them: the options refuse a ranking of several. */
export const TAX_RATE_EXAMPLES = ["MUB --tax-rate 40.8", "CMF --tax-rate 40.8 --state-rate 13.3 --state CA"] as const;

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

/** The same options in `gloomberb help fundamentals`. */
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
 * A fund's tax-equivalent yield and muni/Treasury ratio from its bond facts,
 * the distribution yield it falls back to, and the Treasury curve. Only a
 * fund its sponsor classes as municipal has one; any other says why not.
 */
export function analyzeTaxEquivalent({
  symbol, bond, rates, distribution, treasury,
}: {
  symbol: string;
  bond: FundBondFacts | null | undefined;
  rates: TaxRates;
  /** The distribution yield in percent and its label, for a fund without a SEC yield. */
  distribution?: YieldBasis | null;
  /** The Treasury curve's points, or null when it could not be read. */
  treasury?: readonly TreasuryTenor[] | null;
}): TaxEquivalentAnalysis {
  if (!bond) {
    return { symbol, rates, notApplicable: `no tax-equivalent yield: ${symbol} is not a bond fund with sponsor figures (iShares, Vanguard and SPDR bond ETFs have them)` };
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
  const ratioNote = durationYears == null ? `no ratio: ${symbol}'s sponsor publishes no duration to match a Treasury tenor`
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

/** A short form of the basis for the ratio line: `SEC yield 4.04%`, `distribution yield 3.27%`. */
function basisShort(basis: YieldBasis): string {
  return `${basis.kind === "sec" ? "SEC yield" : "distribution yield"} ${formatFundYield(basis.value)}`;
}

/** One report line: its label, its text, and the raw value JSON keeps. */
export interface TaxEquivalentLine {
  key: "taxRate" | "taxEquivalentYield" | "muniTreasuryRatio";
  label: string;
  text: string;
  value: number | null;
  unit?: string;
}

/**
 * The analysis as report lines, each saying what it was computed from:
 *
 *   Tax rate              40.8% (federal; MUB is a national fund, no state rate)
 *   Tax-equivalent yield  6.83% (30-day SEC yield 4.04% as of 2026-10-15 / (1 - 40.8%))
 *   Muni/Treasury ratio   81.0% (SEC yield 4.04% / 7Y Treasury 4.99% on 2026-10-16, the tenor nearest its 7.13-year duration)
 */
export function taxEquivalentLines(analysis: TaxEquivalentAnalysis): TaxEquivalentLine[] {
  const { rates } = analysis;
  const stateText = !rates.state ? (analysis.notApplicable ? "federal" : "federal; no state rate given")
    : analysis.stateApplied ? `federal ${formatRate(rates.federal)} + ${rates.state.code} ${formatRate(rates.state.rate)}`
    : `federal; ${analysis.stateNote}`;
  const combined = analysis.combinedRate ?? rates.federal;
  const lines: TaxEquivalentLine[] = [
    { key: "taxRate", label: "Tax rate", text: `${formatRate(combined)} (${stateText})`, value: combined, unit: "%" },
  ];
  if (analysis.notApplicable || !analysis.basis || analysis.taxEquivalentYield == null) {
    lines.push({ key: "taxEquivalentYield", label: "Tax-equivalent yield", text: analysis.notApplicable ?? "—", value: null });
    return lines;
  }
  const basis = analysis.basis;
  lines.push({
    key: "taxEquivalentYield",
    label: "Tax-equivalent yield",
    text: `${formatFundYield(analysis.taxEquivalentYield)} (${basis.label} ${formatFundYield(basis.value)}${basis.asOf ? ` as of ${basis.asOf}` : ""} / (1 - ${formatRate(combined)}))`,
    value: Math.round(analysis.taxEquivalentYield * 10_000) / 10_000,
    unit: "%",
  });
  const ratio = analysis.ratio;
  lines.push(ratio
    ? {
      key: "muniTreasuryRatio",
      label: "Muni/Treasury ratio",
      text: `${(ratio.value * 100).toFixed(1)}% (${basisShort(basis)} / ${ratio.treasury.tenor} Treasury ${formatFundYield(ratio.treasury.yield)}`
        + `${ratio.treasury.asOf ? ` on ${ratio.treasury.asOf}` : ""}, the tenor nearest its ${ratio.durationYears.toFixed(2)}-year duration)`,
      value: Math.round(ratio.value * 10_000) / 10_000,
    }
    : { key: "muniTreasuryRatio", label: "Muni/Treasury ratio", text: analysis.ratioNote ?? "—", value: null });
  return lines;
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
      value: tax.ratio.value, tenor: tax.ratio.treasury.tenor, treasuryYield: tax.ratio.treasury.yield,
      treasuryAsOf: tax.ratio.treasury.asOf, durationYears: tax.ratio.durationYears,
    } : null,
    notes: [tax.notApplicable, tax.stateNote, tax.ratioNote].filter((note): note is string => !!note),
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
      : [{ tenor: point.tenor, years: point.years, yield: point.yield, asOf: view.asOf ?? null }]));
  } catch {
    try {
      return finite((await client.getCloudYieldCurve()).flatMap((point) => point.yield == null ? []
        : [{ tenor: point.maturity, years: point.maturityYears, yield: point.yield, asOf: point.asOf ?? null }]));
    } catch {
      // Intentional ignore: the ratio line then says the Treasury curve could not be read.
      return null;
    }
  }
}
