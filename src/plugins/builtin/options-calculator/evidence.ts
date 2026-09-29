import type { DesktopPaneShotPayload } from "../../../cli/desktop-pane-shot";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { DEFAULT_BINOMIAL_STEPS, MAX_BINOMIAL_STEPS, effectiveBinomialSteps, solveBinomialImpliedVolatility,
  validateBinomialInputs, valueBinomialOption } from "./binomial";
import { draftFromCalculatorInputs } from "./inputs";
import { OPTIONS_CALCULATOR_PANE_ID, type OptionCalcDraft } from "./model";
import { solveImpliedVolatility, valueOption, type ImpliedVolatilityResult, type OptionValuation } from "../shared/volatility";
import { createCalculatorSurfaceDependencies, loadCalculatorSurfaceVol, type CalculatorSurfaceVol } from "./surface";
import { isDateString, isFiniteNumber, isRecord, isStringArray } from "../../../utils/guards";

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

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const nullableNumber = (value: unknown): value is number | null => value === null || isFiniteNumber(value);
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
  if (!isRecord(value) || typeof value.symbol !== "string" || !["call", "put"].includes(String(value.side))
    || !["european", "american"].includes(String(value.pricingModel)) || !["input", "surface"].includes(String(value.volSource))
    || !["spot", "strike", "daysToExpiry", "rate", "volatility", "dividendYield", "marketPrice"].every((key) => isFiniteNumber(value[key]))
    || !isFiniteNumber(value.marketPrice) || value.marketPrice < 0 || !isFiniteNumber(value.steps) || !Number.isInteger(value.steps)
    || value.steps < 1 || value.steps > MAX_BINOMIAL_STEPS || !Array.isArray(value.dividends)) return false;
  const draft = value as unknown as CalculatorEvidenceDraft;
  return validateBinomialInputs(draft, { exercise: draft.pricingModel, steps: draft.steps, dividends: draft.dividends }) === null;
}

function validValuation(value: unknown): value is OptionValuation {
  return isRecord(value) && metrics.every((key) => isFiniteNumber(value[key])) && (value.price as number) >= 0;
}

function validImplied(value: unknown): value is ImpliedVolatilityResult {
  return isRecord(value) && nullableNumber(value.volatility) && (value.volatility === null || value.volatility >= 0)
    && nullableText(value.note);
}

function validSurface(value: unknown): value is CalculatorSurfaceVol {
  return isRecord(value) && nullableNumber(value.volatility) && nullableNumber(value.rate) && nullableNumber(value.dividendYield)
    && nullableNumber(value.sourceSpot) && nullableNumber(value.spotAsOf) && nullableText(value.asOf)
    && (value.asOf === null || isDateString(value.asOf))
    && isStringArray(value.rateAsOf) && typeof value.source === "string" && value.source.length > 0
    && isStringArray(value.warnings) && nullableText(value.error);
}

function sourceReady(draft: CalculatorEvidenceDraft, surface: CalculatorSurfaceVol | null): boolean {
  return draft.volSource === "input" || (!!draft.symbol.trim() && !!surface && validSurface(surface)
    && surface.error === null && isFiniteNumber(surface.volatility) && surface.volatility > 0
    && surface.volatility === draft.volatility && isFiniteNumber(surface.sourceSpot) && surface.sourceSpot > 0
    && isFiniteNumber(surface.rate) && isFiniteNumber(surface.dividendYield));
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
    ? isFiniteNumber(input.effectiveSteps) && Number.isInteger(input.effectiveSteps) && input.effectiveSteps >= draft.steps
    : input.effectiveSteps == null;
  const plottedValueCount = (valuation ? metrics.filter((key) => isFiniteNumber(valuation[key])).length : 0)
    + (isFiniteNumber(input.implied.volatility) ? 1 : 0);
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
  if (!isRecord(value) || value.kind !== "options-calculator" || value.version !== 1 || typeof value.symbol !== "string"
    || !validDraft(value.draft) || value.symbol !== value.draft.symbol || !validValuation(value.valuation)
    || !validImplied(value.implied) || !nullableText(value.error) || !isStringArray(value.notices)
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

function capturedCalculatorSnapshot(payload: DesktopPaneShotPayload): CalculatorScreenshotSnapshot | undefined {
  return payload.config?.layout?.instances.find((entry) => entry.instanceId === payload.paneId)
    ?.settings?.calculatorSnapshot as CalculatorScreenshotSnapshot | undefined;
}

export const calculatorScreenshotEvidence: PaneScreenshotEvidenceHook<CalculatorEvidence> = {
  paneId: OPTIONS_CALCULATOR_PANE_ID,
  kind: "options-calculator",
  label: "option calculator",
  read: readCalculatorEvidence,
  visibleLabels: ["Model", "Implied IV", "Delta", "Gamma", "Theta", "Vega", "Rho"],
  async prepare({ resolved, context, settings }) {
    // The screenshot and verifier consume the same inputs and market fit.
    // Explicit input-IV pricing does not need unrelated quote/history requests.
    const draft = draftFromCalculatorInputs({ ...settings, ...resolved.options });
    let surface: CalculatorScreenshotSnapshot["surface"] = null;
    if (draft.volSource === "surface") {
      if (!draft.symbol) throw new Error("Surface volatility requires --symbol.");
      const parsed = parsePublicTickerKey(draft.symbol);
      const ticker = await context.store.loadTicker(draft.symbol)
        ?? (draft.symbol !== parsed.symbol ? await context.store.loadTicker(parsed.symbol) : null);
      surface = await loadCalculatorSurfaceVol({ symbol: parsed.symbol, exchange: parsed.exchange ?? ticker?.metadata.exchange,
        spot: draft.spot, strike: draft.strike, daysToExpiry: draft.daysToExpiry,
      }, createCalculatorSurfaceDependencies(context.dataProvider));
    }
    return { settings: { calculatorSnapshot: { draft, surface } satisfies CalculatorScreenshotSnapshot } };
  },
  symbols({ payload }) {
    const symbol = capturedCalculatorSnapshot(payload)?.draft.symbol;
    return symbol ? [symbol] : null;
  },
  expectedText({ resolved }) {
    const symbol = resolved.options.symbol;
    return typeof symbol === "string" && symbol ? [symbol] : [];
  },
  /** A self-consistent calculator must also represent the requested assumptions. */
  mismatches(evidence, { resolved, payload }) {
    const snapshot = capturedCalculatorSnapshot(payload);
    if (!snapshot?.draft) return ["option calculator screenshot inputs are missing"];
    const mismatches: string[] = [];
    try {
      const requested = normalizeCalculatorEvidenceDraft(draftFromCalculatorInputs({ ...resolved.instance?.settings, ...resolved.options }));
      if (JSON.stringify(normalizeCalculatorEvidenceDraft(snapshot.draft)) !== JSON.stringify(requested)) {
        mismatches.push("option calculator snapshot does not match requested inputs");
      }
    } catch {
      mismatches.push("requested option calculator inputs are invalid");
    }
    const expectedDraft = normalizeCalculatorEvidenceDraft({ ...snapshot.draft,
      ...(snapshot.draft.volSource === "surface" && snapshot.surface?.volatility != null
        ? { volatility: snapshot.surface.volatility } : {}) });
    if (JSON.stringify(evidence.draft) !== JSON.stringify(expectedDraft)) {
      mismatches.push("rendered option calculator inputs do not match");
    }
    if (JSON.stringify(evidence.surface) !== JSON.stringify(snapshot.surface)) {
      mismatches.push("rendered option calculator surface does not match");
    }
    return mismatches;
  },
  unavailable(evidence, { resolved }) {
    return evidence?.complete && !evidence.loading ? [] : [evidence?.symbol || String(resolved.options.symbol ?? "option calculator")];
  },
};
