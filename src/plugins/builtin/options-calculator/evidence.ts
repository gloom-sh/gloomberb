import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { DEFAULT_BINOMIAL_STEPS, MAX_BINOMIAL_STEPS, effectiveBinomialSteps, solveBinomialImpliedVolatility,
  validateBinomialInputs, valueBinomialOption } from "./binomial";
import { solveImpliedVolatility, valueOption, type ImpliedVolatilityResult, type OptionCalcDraft,
  type OptionValuation } from "./model";
import type { CalculatorSurfaceVol } from "./surface";

export const CALCULATOR_IGNORED_DIVIDENDS_NOTICE = "Cash dividend schedule is ignored by the European model; continuous yield applies.";

export interface CalculatorScreenshotSnapshot {
  draft: OptionCalcDraft;
  surface: CalculatorSurfaceVol | null;
}

export type CalculatorEvidenceDraft = OptionCalcDraft & Required<Pick<OptionCalcDraft,
  "pricingModel" | "volSource" | "steps" | "dividends">>;

export interface CalculatorEvidenceInput {
  /** The effective IV and parsed cash schedule used by the rendered calculation. */
  draft: OptionCalcDraft;
  valuation: OptionValuation | null | undefined;
  implied: ImpliedVolatilityResult;
  surface?: CalculatorSurfaceVol | null;
  effectiveSteps?: number | null;
  loading: boolean;
  error?: string | null;
  notices?: readonly string[];
}

export interface CalculatorEvidence {
  kind: "options-calculator";
  version: 1;
  symbol: string;
  draft: CalculatorEvidenceDraft;
  valuation: OptionValuation | null;
  implied: ImpliedVolatilityResult;
  surface: CalculatorSurfaceVol | null;
  effectiveSteps: number | null;
  loading: boolean;
  error: string | null;
  notices: string[];
  complete: boolean;
  plottedValueCount: number;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const nullableNumber = (value: unknown): value is number | null => value === null || finite(value);
const metrics = ["price", "delta", "gamma", "thetaPerDay", "vegaPerPoint", "rhoPerPoint"] as const;
const sameNumber = (actual: number, expected: number): boolean => Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));

/** Canonical field order keeps serialized input comparisons stable across pane and CLI construction. */
export function normalizeCalculatorEvidenceDraft(draft: OptionCalcDraft): CalculatorEvidenceDraft {
  const reference = draft.marketReference;
  return {
    symbol: draft.symbol, side: draft.side, spot: draft.spot, strike: draft.strike, daysToExpiry: draft.daysToExpiry,
    rate: draft.rate, volatility: draft.volatility, dividendYield: draft.dividendYield, marketPrice: draft.marketPrice,
    marketPriceSource: draft.marketPriceSource,
    marketReference: reference ? { contractSymbol: reference.contractSymbol, expiration: reference.expiration,
      currency: reference.currency, bid: reference.bid, ask: reference.ask, lastPrice: reference.lastPrice,
      lastTradeDate: reference.lastTradeDate, lastUpdated: reference.lastUpdated } : undefined,
    pricingModel: draft.pricingModel ?? "european", volSource: draft.volSource ?? "input",
    steps: draft.steps ?? DEFAULT_BINOMIAL_STEPS,
    dividends: (draft.dividends ?? []).map(({ days, amount }) => ({ days, amount })),
  };
}

function validDraft(value: unknown): value is CalculatorEvidenceDraft {
  if (!record(value) || typeof value.symbol !== "string" || !["call", "put"].includes(String(value.side))
    || !["european", "american"].includes(String(value.pricingModel)) || !["input", "surface"].includes(String(value.volSource))
    || !["spot", "strike", "daysToExpiry", "rate", "volatility", "dividendYield", "marketPrice"].every((key) => finite(value[key]))
    || !finite(value.marketPrice) || value.marketPrice < 0 || !finite(value.steps) || !Number.isInteger(value.steps)
    || value.steps < 1 || value.steps > MAX_BINOMIAL_STEPS || !Array.isArray(value.dividends)) return false;
  const draft = value as unknown as CalculatorEvidenceDraft;
  return validateBinomialInputs(draft, { exercise: draft.pricingModel, steps: draft.steps, dividends: draft.dividends }) === null;
}

function validValuation(value: unknown): value is OptionValuation {
  return record(value) && metrics.every((key) => finite(value[key])) && (value.price as number) >= 0;
}

function validImplied(value: unknown): value is ImpliedVolatilityResult {
  return record(value) && nullableNumber(value.volatility) && (value.volatility === null || value.volatility >= 0)
    && nullableText(value.note);
}

function validSurface(value: unknown): value is CalculatorSurfaceVol {
  return record(value) && nullableNumber(value.volatility) && nullableNumber(value.rate) && nullableNumber(value.dividendYield)
    && nullableNumber(value.sourceSpot) && nullableNumber(value.spotAsOf) && nullableText(value.asOf)
    && (value.asOf === null || Number.isFinite(Date.parse(value.asOf)))
    && strings(value.rateAsOf) && typeof value.source === "string" && value.source.length > 0
    && strings(value.warnings) && nullableText(value.error);
}

function sourceReady(draft: CalculatorEvidenceDraft, surface: CalculatorSurfaceVol | null): boolean {
  return draft.volSource === "input" || (!!draft.symbol.trim() && !!surface && validSurface(surface)
    && surface.error === null && finite(surface.volatility) && surface.volatility > 0
    && surface.volatility === draft.volatility && finite(surface.sourceSpot) && surface.sourceSpot > 0
    && finite(surface.rate) && finite(surface.dividendYield));
}

function noticesPreserved(draft: CalculatorEvidenceDraft, surface: CalculatorSurfaceVol | null, notices: string[]): boolean {
  return (draft.pricingModel !== "european" || draft.dividends.length === 0 || notices.includes(CALCULATOR_IGNORED_DIVIDENDS_NOTICE))
    && (draft.volSource !== "surface" || !surface || surface.warnings.every((warning) => notices.includes(warning)));
}

/** Project the values actually rendered; verification reprices only when a capture is inspected. */
export function calculatorSemanticEvidence(input: CalculatorEvidenceInput): CalculatorEvidence {
  const draft = normalizeCalculatorEvidenceDraft(input.draft);
  const valuation = input.valuation ?? null;
  const surface = draft.volSource === "surface" ? input.surface ?? null : null;
  const notices = [...(input.notices ?? [])];
  const stepsReady = draft.pricingModel === "american"
    ? finite(input.effectiveSteps) && Number.isInteger(input.effectiveSteps) && input.effectiveSteps >= draft.steps
    : input.effectiveSteps == null;
  const plottedValueCount = (valuation ? metrics.filter((key) => finite(valuation[key])).length : 0)
    + (finite(input.implied.volatility) ? 1 : 0);
  return { kind: "options-calculator", version: 1, symbol: draft.symbol, draft, valuation, implied: { ...input.implied },
    surface, effectiveSteps: input.effectiveSteps ?? null, loading: input.loading, error: input.error ?? null, notices,
    complete: !input.loading && input.error == null && validDraft(draft) && validValuation(valuation)
      && validImplied(input.implied) && stepsReady && sourceReady(draft, surface) && noticesPreserved(draft, surface, notices),
    plottedValueCount };
}

export function useCalculatorEvidence(input: CalculatorEvidenceInput): void {
  useRemoteUiNode({ role: "chart-data", label: "Rendered option valuation observations",
    getMetadata: () => ({ ...calculatorSemanticEvidence(input) }) });
}

/** Reprice the selected exercise model, schedule, Greeks and IV before accepting rendered observations. */
export function readCalculatorEvidence(value: unknown): CalculatorEvidence | null {
  if (!record(value) || value.kind !== "options-calculator" || value.version !== 1 || typeof value.symbol !== "string"
    || !validDraft(value.draft) || value.symbol !== value.draft.symbol || !validValuation(value.valuation)
    || !validImplied(value.implied) || !nullableText(value.error) || !strings(value.notices)
    || typeof value.loading !== "boolean" || typeof value.complete !== "boolean"
    || (value.surface !== null && !validSurface(value.surface))) return null;
  const evidence = value as unknown as CalculatorEvidence;
  const { draft, surface, notices } = evidence;
  if (draft.volSource === "input" && surface !== null || !sourceReady(draft, surface)
    || !noticesPreserved(draft, surface, notices)) return null;
  let expected: OptionValuation, implied: ImpliedVolatilityResult, steps: number | null = null;
  try {
    const options = { exercise: draft.pricingModel, steps: draft.steps, dividends: draft.dividends };
    if (draft.pricingModel === "american") {
      expected = valueBinomialOption(draft, options);
      implied = solveBinomialImpliedVolatility(draft, draft.marketPrice, options);
      steps = effectiveBinomialSteps(draft, options);
    } else {
      expected = valueOption(draft);
      implied = solveImpliedVolatility(draft, draft.marketPrice);
    }
  } catch { return null; }
  if (!validValuation(expected) || metrics.some((key) => !sameNumber(evidence.valuation![key], expected[key]))
    || evidence.implied.note !== implied.note || (implied.volatility === null ? evidence.implied.volatility !== null
      : evidence.implied.volatility === null || !sameNumber(evidence.implied.volatility, implied.volatility))
    || evidence.effectiveSteps !== steps) return null;
  const count = metrics.length + (implied.volatility !== null ? 1 : 0);
  if (evidence.plottedValueCount !== count || evidence.complete !== (!evidence.loading && evidence.error === null)) return null;
  return evidence;
}
