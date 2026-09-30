export type KellySizingMode =
  | "binary"
  | "scenario"
  | "risk-budget"
  | "prediction-market"
  | "asymmetric";

export interface KellyCommonAssumptions {
  kellyFraction: number;
  maxNameFraction: number;
  maxLossFraction: number;
}

export interface BinaryKellyAssumptions extends KellyCommonAssumptions {
  winProbability: number;
  upsideReturn: number;
  downsideReturn: number;
}

interface ScenarioKellyOutcome {
  id: string;
  label: string;
  probability: number;
  returnPct: number;
}

export interface ScenarioKellyAssumptions extends KellyCommonAssumptions {
  outcomes: ScenarioKellyOutcome[];
}

export interface RiskBudgetKellyAssumptions extends KellyCommonAssumptions {
  riskBudgetFraction: number;
  downsideReturn: number;
  winProbability: number;
  upsideReturn: number;
}

export interface PredictionMarketKellyAssumptions extends KellyCommonAssumptions {
  estimatedProbability: number;
  marketPrice: number;
  side: "yes" | "no";
}

export interface AsymmetricKellyAssumptions extends KellyCommonAssumptions {
  winProbability: number;
  targetReturn: number;
  maxLossReturn: number;
}

export interface KellySizerModeDrafts {
  binary: BinaryKellyAssumptions;
  scenario: ScenarioKellyAssumptions;
  "risk-budget": RiskBudgetKellyAssumptions;
  "prediction-market": PredictionMarketKellyAssumptions;
  asymmetric: AsymmetricKellyAssumptions;
}

export type KellySizerDraft = KellySizerModeDrafts[KellySizingMode];

export interface KellyOutcome {
  probability: number;
  returnPct: number;
}

export interface KellySolveResult {
  fraction: number;
  expectedReturn: number;
  expectedLogGrowth: number;
  warning?: string;
}

export interface KellySizingResult {
  mode: KellySizingMode;
  bankroll: number;
  currentValue: number;
  currentFraction: number;
  price: number | null;
  fullKellyFraction: number;
  fractionalKellyFraction: number;
  unclippedFraction: number;
  clippedFraction: number;
  targetValue: number;
  addTrimValue: number;
  estimatedUnits: number | null;
  downsideLossFraction: number;
  riskValue: number;
  riskFraction: number;
  expectedReturn: number;
  expectedLogGrowth: number;
  warnings: string[];
  clipReasons: string[];
  recommendationLabel: string;
}

export interface SensitivityGridCell {
  fraction: number | null;
  text: string;
}

export interface SensitivityGrid {
  rowLabel: string;
  columnLabel: string;
  rows: string[];
  columns: string[];
  cells: SensitivityGridCell[][];
}

export const KELLY_MODES: Array<{ id: KellySizingMode; label: string }> = [
  { id: "binary", label: "Binary" },
  { id: "scenario", label: "Scenario" },
  { id: "risk-budget", label: "Risk" },
  { id: "prediction-market", label: "Market" },
  { id: "asymmetric", label: "Asym" },
];

export const DEFAULT_KELLY_COMMON_ASSUMPTIONS: KellyCommonAssumptions = {
  kellyFraction: 0.25,
  maxNameFraction: 0.08,
  maxLossFraction: 0.01,
};

export const DEFAULT_KELLY_DRAFTS: KellySizerModeDrafts = {
  binary: {
    winProbability: 0.57,
    upsideReturn: 0.24,
    downsideReturn: -0.09,
    ...DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  },
  scenario: {
    outcomes: [
      { id: "bear", label: "Bear", probability: 0.25, returnPct: -0.12 },
      { id: "base", label: "Base", probability: 0.45, returnPct: 0.08 },
      { id: "bull", label: "Bull", probability: 0.30, returnPct: 0.28 },
    ],
    ...DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  },
  "risk-budget": {
    riskBudgetFraction: 0.01,
    downsideReturn: -0.09,
    winProbability: 0.57,
    upsideReturn: 0.24,
    ...DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  },
  "prediction-market": {
    estimatedProbability: 0.57,
    marketPrice: 0.48,
    side: "yes",
    ...DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  },
  asymmetric: {
    winProbability: 0.42,
    targetReturn: 1.5,
    maxLossReturn: -1,
    ...DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  },
};
