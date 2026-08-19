import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import {
  DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  DEFAULT_KELLY_DRAFTS,
  type AsymmetricKellyAssumptions,
  type BinaryKellyAssumptions,
  type KellyCommonAssumptions,
  type KellyOutcome,
  type KellySizerDraft,
  type KellySizerModeDrafts,
  type KellySizingMode,
  type KellySizingResult,
  type KellySolveResult,
  type PredictionMarketKellyAssumptions,
  type RiskBudgetKellyAssumptions,
  type ScenarioKellyAssumptions,
  type SensitivityGrid,
  type SensitivityGridCell,
} from "./types";
export {
  DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  DEFAULT_KELLY_DRAFTS,
  KELLY_MODES,
} from "./types";
export type {
  AsymmetricKellyAssumptions,
  BinaryKellyAssumptions,
  KellyCommonAssumptions,
  KellyOutcome,
  KellySizerDraft,
  KellySizerModeDrafts,
  KellySizingMode,
  KellySizingResult,
  KellySolveResult,
  PredictionMarketKellyAssumptions,
  RiskBudgetKellyAssumptions,
  ScenarioKellyAssumptions,
  ScenarioKellyOutcome,
  SensitivityGrid,
  SensitivityGridCell,
} from "./types";

const MAX_NUMERIC_KELLY_FRACTION = 10;
/** Widest Kelly curve window worth drawing: 200% of bankroll. */
const KELLY_CURVE_DISPLAY_CAP = 2;
const SOLVER_ITERATIONS = 80;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizeFraction(value: number, fallback: number, min = 0, max = 1): number {
  return finite(value) ? clamp(value, min, max) : fallback;
}

function normalizeProbability(value: number): number {
  return sanitizeFraction(value, 0, 0, 1);
}

function normalizeOutcomes(outcomes: KellyOutcome[]): KellyOutcome[] {
  const valid = outcomes.filter((outcome) => (
    finite(outcome.probability)
    && outcome.probability > 0
    && finite(outcome.returnPct)
    && outcome.returnPct >= -1
  ));
  const totalProbability = valid.reduce((sum, outcome) => sum + outcome.probability, 0);
  if (totalProbability <= 0) return [];
  return valid.map((outcome) => ({
    probability: outcome.probability / totalProbability,
    returnPct: outcome.returnPct,
  }));
}

function expectedReturn(outcomes: KellyOutcome[]): number {
  return outcomes.reduce((sum, outcome) => sum + outcome.probability * outcome.returnPct, 0);
}

export function computeExpectedLogGrowth(fraction: number, outcomes: KellyOutcome[]): number {
  if (!finite(fraction) || fraction < 0) return Number.NEGATIVE_INFINITY;
  let growth = 0;
  for (const outcome of outcomes) {
    const terminalValue = 1 + fraction * outcome.returnPct;
    if (terminalValue <= 0) return Number.NEGATIVE_INFINITY;
    growth += outcome.probability * Math.log(terminalValue);
  }
  return growth;
}

export function calculateExpectedLogGrowthAtFraction(
  mode: KellySizingMode,
  draft: KellySizerDraft,
  fraction: number,
): number {
  if (!finite(fraction) || fraction < 0) return 0;
  const { outcomes } = getModeOutcomes(mode, draft);
  const normalizedOutcomes = normalizeOutcomes(outcomes);
  if (normalizedOutcomes.length === 0) return 0;
  const growth = computeExpectedLogGrowth(fraction, normalizedOutcomes);
  return finite(growth) ? growth : 0;
}

function derivativeAt(fraction: number, outcomes: KellyOutcome[]): number {
  let derivative = 0;
  for (const outcome of outcomes) {
    derivative += outcome.probability * outcome.returnPct / (1 + fraction * outcome.returnPct);
  }
  return derivative;
}

export function solveKellyFraction(rawOutcomes: KellyOutcome[]): KellySolveResult {
  const outcomes = normalizeOutcomes(rawOutcomes);
  if (outcomes.length === 0) {
    return {
      fraction: 0,
      expectedReturn: 0,
      expectedLogGrowth: 0,
      warning: "No valid payoff outcomes.",
    };
  }

  const edge = expectedReturn(outcomes);
  if (edge <= 0) {
    return {
      fraction: 0,
      expectedReturn: edge,
      expectedLogGrowth: 0,
    };
  }

  const negativeReturns = outcomes.map((outcome) => outcome.returnPct).filter((value) => value < 0);
  if (negativeReturns.length === 0) {
    return {
      fraction: MAX_NUMERIC_KELLY_FRACTION,
      expectedReturn: edge,
      expectedLogGrowth: computeExpectedLogGrowth(MAX_NUMERIC_KELLY_FRACTION, outcomes),
      warning: "No downside outcome; Kelly is unbounded.",
    };
  }

  const worstReturn = Math.min(...negativeReturns);
  let low = 0;
  let high = Math.min(MAX_NUMERIC_KELLY_FRACTION, (-1 / worstReturn) * 0.999999);
  if (!finite(high) || high <= 0) {
    return {
      fraction: 0,
      expectedReturn: edge,
      expectedLogGrowth: 0,
      warning: "Invalid downside domain.",
    };
  }

  if (derivativeAt(low, outcomes) <= 0) {
    return {
      fraction: 0,
      expectedReturn: edge,
      expectedLogGrowth: 0,
    };
  }

  const highDerivative = derivativeAt(high, outcomes);
  if (highDerivative > 0) {
    return {
      fraction: high,
      expectedReturn: edge,
      expectedLogGrowth: computeExpectedLogGrowth(high, outcomes),
      warning: "Optimum is beyond the pane's solver cap.",
    };
  }

  for (let i = 0; i < SOLVER_ITERATIONS; i++) {
    const mid = (low + high) / 2;
    if (derivativeAt(mid, outcomes) > 0) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const fraction = (low + high) / 2;
  return {
    fraction,
    expectedReturn: edge,
    expectedLogGrowth: computeExpectedLogGrowth(fraction, outcomes),
  };
}

export function buildBinaryOutcomes(
  winProbability: number,
  upsideReturn: number,
  downsideReturn: number,
): KellyOutcome[] {
  const probability = normalizeProbability(winProbability);
  return [
    { probability, returnPct: Math.max(0, upsideReturn) },
    { probability: 1 - probability, returnPct: Math.min(0, downsideReturn) },
  ];
}

function getModeOutcomes(
  mode: KellySizingMode,
  draft: KellySizerDraft,
): { outcomes: KellyOutcome[]; recommendationLabel: string; warnings: string[] } {
  if (mode === "binary") {
    const binary = draft as BinaryKellyAssumptions;
    return {
      outcomes: buildBinaryOutcomes(binary.winProbability, binary.upsideReturn, binary.downsideReturn),
      recommendationLabel: "Binary thesis",
      warnings: [],
    };
  }

  if (mode === "scenario") {
    const scenario = draft as ScenarioKellyAssumptions;
    return {
      outcomes: scenario.outcomes.map((outcome) => ({
        probability: outcome.probability,
        returnPct: outcome.returnPct,
      })),
      recommendationLabel: "Scenario tree",
      warnings: [],
    };
  }

  if (mode === "risk-budget") {
    const risk = draft as RiskBudgetKellyAssumptions;
    return {
      outcomes: buildBinaryOutcomes(risk.winProbability, risk.upsideReturn, risk.downsideReturn),
      recommendationLabel: "Risk budget",
      warnings: [],
    };
  }

  if (mode === "prediction-market") {
    const market = draft as PredictionMarketKellyAssumptions;
    const price = sanitizeFraction(market.side === "yes" ? market.marketPrice : 1 - market.marketPrice, 0, 0.0001, 0.9999);
    const winProbability = market.side === "yes"
      ? normalizeProbability(market.estimatedProbability)
      : 1 - normalizeProbability(market.estimatedProbability);
    return {
      outcomes: buildBinaryOutcomes(winProbability, (1 - price) / price, -1),
      recommendationLabel: `${market.side.toUpperCase()} contract`,
      warnings: [],
    };
  }

  const asymmetric = draft as AsymmetricKellyAssumptions;
  return {
    outcomes: buildBinaryOutcomes(
      asymmetric.winProbability,
      asymmetric.targetReturn,
      asymmetric.maxLossReturn,
    ),
    recommendationLabel: "Asymmetric payoff",
    warnings: [],
  };
}

function getCommonAssumptions(draft: KellySizerDraft): KellyCommonAssumptions {
  return normalizeKellyCommonAssumptions(draft);
}

export function normalizeKellyCommonAssumptions(
  value: Partial<KellyCommonAssumptions> | null | undefined,
  fallback: KellyCommonAssumptions = DEFAULT_KELLY_COMMON_ASSUMPTIONS,
): KellyCommonAssumptions {
  return {
    kellyFraction: sanitizeFraction(value?.kellyFraction ?? fallback.kellyFraction, fallback.kellyFraction, 0, 1),
    maxNameFraction: sanitizeFraction(value?.maxNameFraction ?? fallback.maxNameFraction, fallback.maxNameFraction, 0, 1),
    maxLossFraction: sanitizeFraction(value?.maxLossFraction ?? fallback.maxLossFraction, fallback.maxLossFraction, 0, 1),
  };
}

export function applyKellyCommonAssumptions<T extends KellySizerDraft>(
  draft: T,
  common: KellyCommonAssumptions,
): T {
  return {
    ...draft,
    ...normalizeKellyCommonAssumptions(common),
  };
}

function getDownsideLossFraction(mode: KellySizingMode, draft: KellySizerDraft, outcomes: KellyOutcome[]): number {
  if (mode === "risk-budget") {
    return Math.abs(Math.min(0, (draft as RiskBudgetKellyAssumptions).downsideReturn));
  }
  const worstReturn = Math.min(...outcomes.map((outcome) => outcome.returnPct), 0);
  return Math.abs(worstReturn);
}

export function calculateKellySizing({
  mode,
  draft,
  bankroll,
  currentValue = 0,
  price = null,
}: {
  mode: KellySizingMode;
  draft: KellySizerDraft;
  bankroll: number;
  currentValue?: number;
  price?: number | null;
}): KellySizingResult {
  const warnings: string[] = [];
  if (!finite(bankroll) || bankroll <= 0) {
    return {
      mode,
      bankroll: 0,
      currentValue: 0,
      currentFraction: 0,
      price: null,
      fullKellyFraction: 0,
      fractionalKellyFraction: 0,
      unclippedFraction: 0,
      clippedFraction: 0,
      targetValue: 0,
      addTrimValue: 0,
      estimatedUnits: null,
      downsideLossFraction: 0,
      riskValue: 0,
      riskFraction: 0,
      expectedReturn: 0,
      expectedLogGrowth: 0,
      warnings: ["No positive bankroll available."],
      clipReasons: [],
      recommendationLabel: "Unavailable",
    };
  }

  const { outcomes, recommendationLabel, warnings: outcomeWarnings } = getModeOutcomes(mode, draft);
  warnings.push(...outcomeWarnings);
  const normalizedOutcomes = normalizeOutcomes(outcomes);
  const solve = solveKellyFraction(normalizedOutcomes);
  if (solve.warning) warnings.push(solve.warning);

  const common = getCommonAssumptions(draft);
  const downsideLossFraction = getDownsideLossFraction(mode, draft, normalizedOutcomes);
  const fullKellyFraction = Math.max(0, solve.fraction);
  const fractionalKellyFraction = fullKellyFraction * common.kellyFraction;
  const riskBudgetFraction = mode === "risk-budget"
    ? (draft as RiskBudgetKellyAssumptions).riskBudgetFraction
    : null;
  const riskBudgetSize = riskBudgetFraction != null && downsideLossFraction > 0
    ? Math.max(0, riskBudgetFraction) / downsideLossFraction
    : null;
  const unclippedFraction = riskBudgetSize ?? fractionalKellyFraction;
  let clippedFraction = Math.max(0, unclippedFraction);
  const clipReasons: string[] = [];

  if (common.maxLossFraction > 0 && downsideLossFraction > 0) {
    const lossCapFraction = common.maxLossFraction / downsideLossFraction;
    if (clippedFraction > lossCapFraction) {
      clippedFraction = lossCapFraction;
      clipReasons.push("max loss");
    }
  }

  if (common.maxNameFraction > 0 && clippedFraction > common.maxNameFraction) {
    clippedFraction = common.maxNameFraction;
    clipReasons.push("max name");
  }

  const safeCurrentValue = finite(currentValue) ? Math.max(0, currentValue) : 0;
  const safePrice = price != null && finite(price) && price > 0 ? price : null;
  const targetValue = clippedFraction * bankroll;
  const addTrimValue = targetValue - safeCurrentValue;
  const estimatedUnits = safePrice ? addTrimValue / safePrice : null;
  const riskFraction = clippedFraction * downsideLossFraction;
  const riskValue = riskFraction * bankroll;

  if (fullKellyFraction === 0 && solve.expectedReturn <= 0) warnings.push("No positive Kelly edge.");
  if (downsideLossFraction <= 0) warnings.push("No downside assumption; risk caps cannot bind.");

  return {
    mode,
    bankroll,
    currentValue: safeCurrentValue,
    currentFraction: safeCurrentValue / bankroll,
    price: safePrice,
    fullKellyFraction,
    fractionalKellyFraction,
    unclippedFraction,
    clippedFraction,
    targetValue,
    addTrimValue,
    estimatedUnits,
    downsideLossFraction,
    riskValue,
    riskFraction,
    expectedReturn: solve.expectedReturn,
    expectedLogGrowth: solve.expectedLogGrowth,
    warnings,
    clipReasons,
    recommendationLabel,
  };
}

function formatPercentCell(value: number | null): string {
  if (value == null || !finite(value)) return "—";
  return `${(value * 100).toFixed(Math.abs(value) >= 0.1 ? 1 : 2)}%`;
}

function resultForSensitivity(mode: KellySizingMode, draft: KellySizerDraft): SensitivityGridCell {
  const result = calculateKellySizing({
    mode,
    draft,
    bankroll: 100,
    currentValue: 0,
    price: 1,
  });
  return {
    fraction: result.clippedFraction,
    text: formatPercentCell(result.clippedFraction),
  };
}

function applyCommon<T extends KellyCommonAssumptions>(base: T, patch: Partial<T>): T {
  return { ...base, ...patch };
}

function probabilityLabels(center: number): number[] {
  return [-0.05, 0, 0.05].map((offset) => clamp(center + offset, 0.01, 0.99));
}

export function buildSensitivityGrid(mode: KellySizingMode, draft: KellySizerDraft): SensitivityGrid {
  if (mode === "prediction-market") {
    const market = draft as PredictionMarketKellyAssumptions;
    const rows = probabilityLabels(market.estimatedProbability);
    const columns = [-0.05, 0, 0.05].map((offset) => clamp(market.marketPrice + offset, 0.01, 0.99));
    return {
      rowLabel: "Est p",
      columnLabel: "Price",
      rows: rows.map(formatPercentCell),
      columns: columns.map(formatPercentCell),
      cells: rows.map((estimatedProbability) => columns.map((marketPrice) => (
        resultForSensitivity(mode, applyCommon(market, { estimatedProbability, marketPrice }))
      ))),
    };
  }

  if (mode === "scenario") {
    const scenario = draft as ScenarioKellyAssumptions;
    const bear = scenario.outcomes[0] ?? DEFAULT_KELLY_DRAFTS.scenario.outcomes[0]!;
    const base = scenario.outcomes[1] ?? DEFAULT_KELLY_DRAFTS.scenario.outcomes[1]!;
    const bull = scenario.outcomes[2] ?? DEFAULT_KELLY_DRAFTS.scenario.outcomes[2]!;
    const bearProbabilities = probabilityLabels(bear.probability);
    const bullReturns = [-0.06, 0, 0.06].map((offset) => bull.returnPct + offset);
    return {
      rowLabel: "Bear p",
      columnLabel: "Bull ret",
      rows: bearProbabilities.map(formatPercentCell),
      columns: bullReturns.map(formatPercentCell),
      cells: bearProbabilities.map((bearProbability) => bullReturns.map((bullReturn) => {
        const bullProbability = bull.probability;
        const baseProbability = Math.max(0.01, 1 - bearProbability - bullProbability);
        return resultForSensitivity(mode, {
          ...scenario,
          outcomes: [
            { ...bear, probability: bearProbability },
            { ...base, probability: baseProbability },
            { ...bull, returnPct: bullReturn },
          ],
        });
      })),
    };
  }

  const twoOutcome = mode === "risk-budget"
    ? draft as RiskBudgetKellyAssumptions
    : mode === "asymmetric"
      ? draft as AsymmetricKellyAssumptions
      : draft as BinaryKellyAssumptions;
  const winProbability = "winProbability" in twoOutcome ? twoOutcome.winProbability : 0.5;
  const upside = "upsideReturn" in twoOutcome
    ? twoOutcome.upsideReturn
    : (twoOutcome as AsymmetricKellyAssumptions).targetReturn;
  const rows = probabilityLabels(winProbability);
  const columns = [-0.06, 0, 0.06].map((offset) => Math.max(0.01, upside + offset));

  return {
    rowLabel: "Win p",
    columnLabel: "Upside",
    rows: rows.map(formatPercentCell),
    columns: columns.map(formatPercentCell),
    cells: rows.map((probability) => columns.map((upsideReturn) => {
      if (mode === "risk-budget") {
        return resultForSensitivity(mode, applyCommon(draft as RiskBudgetKellyAssumptions, {
          winProbability: probability,
          upsideReturn,
        }));
      }
      if (mode === "asymmetric") {
        return resultForSensitivity(mode, applyCommon(draft as AsymmetricKellyAssumptions, {
          winProbability: probability,
          targetReturn: upsideReturn,
        }));
      }
      return resultForSensitivity(mode, applyCommon(draft as BinaryKellyAssumptions, {
        winProbability: probability,
        upsideReturn,
      }));
    })),
  };
}

export function buildKellyCurvePoints(
  mode: KellySizingMode,
  draft: KellySizerDraft,
  maxFractionOverride?: number,
): ProjectedChartPoint[] {
  const { outcomes } = getModeOutcomes(mode, draft);
  const normalizedOutcomes = normalizeOutcomes(outcomes);
  if (normalizedOutcomes.length === 0) return [];
  const maxFraction = maxFractionOverride ?? getKellyCurveMaxFraction(mode, draft);
  if (maxFraction <= 0) return [];

  return Array.from({ length: 32 }, (_, index) => {
    const fraction = (maxFraction * index) / 31;
    const growth = computeExpectedLogGrowth(fraction, normalizedOutcomes);
    const safeGrowth = finite(growth) ? growth : 0;
    return {
      date: new Date(Date.UTC(2026, 0, 1 + index)),
      open: safeGrowth,
      high: safeGrowth,
      low: safeGrowth,
      close: safeGrowth,
      volume: 0,
    };
  });
}

export function getKellyCurveMaxFraction(
  mode: KellySizingMode,
  draft: KellySizerDraft,
  focusFractions: number[] = [],
): number {
  const { outcomes } = getModeOutcomes(mode, draft);
  const normalizedOutcomes = normalizeOutcomes(outcomes);
  if (normalizedOutcomes.length === 0) return 0;

  const result = calculateKellySizing({
    mode,
    draft,
    bankroll: 100,
    currentValue: 0,
    price: 1,
  });
  const worstReturn = Math.min(...normalizedOutcomes.map((outcome) => outcome.returnPct), 0);
  const domainLimit = worstReturn < 0 ? (-1 / worstReturn) * 0.95 : MAX_NUMERIC_KELLY_FRACTION;
  const focusMax = Math.max(0, ...focusFractions.filter((value) => finite(value) && value >= 0));
  const maxFraction = clamp(
    // Capped for readability: a shallow downside pushes the mathematical domain
    // past 600% of bankroll, which squeezes every decision point into one column.
    Math.min(
      Math.max(result.fullKellyFraction * 1.4, result.clippedFraction * 2, focusMax * 1.15, 0.2),
      KELLY_CURVE_DISPLAY_CAP,
    ),
    0.05,
    Math.min(MAX_NUMERIC_KELLY_FRACTION, domainLimit),
  );
  return maxFraction;
}

export function cloneKellyDrafts(drafts: Partial<KellySizerModeDrafts> = DEFAULT_KELLY_DRAFTS): KellySizerModeDrafts {
  const binary = { ...DEFAULT_KELLY_DRAFTS.binary, ...drafts.binary };
  const scenario = {
    ...DEFAULT_KELLY_DRAFTS.scenario,
    ...drafts.scenario,
    outcomes: (drafts.scenario?.outcomes ?? DEFAULT_KELLY_DRAFTS.scenario.outcomes).map((outcome) => ({ ...outcome })),
  };
  const riskBudget = { ...DEFAULT_KELLY_DRAFTS["risk-budget"], ...drafts["risk-budget"] };
  const predictionMarket = { ...DEFAULT_KELLY_DRAFTS["prediction-market"], ...drafts["prediction-market"] };
  const asymmetric = { ...DEFAULT_KELLY_DRAFTS.asymmetric, ...drafts.asymmetric };

  return {
    binary,
    scenario,
    "risk-budget": riskBudget,
    "prediction-market": predictionMarket,
    asymmetric,
  };
}
