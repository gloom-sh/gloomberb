import {
  type KellyCommonAssumptions,
  type KellySizerDraft,
  type KellySizerModeDrafts,
  type KellySizingMode,
  type ScenarioKellyAssumptions,
} from "./types";
import type { GridField } from "../../../components";

export function buildModeFields({
  mode,
  draft,
  updateDraft,
}: {
  mode: KellySizingMode;
  draft: KellySizerDraft;
  updateDraft: (patch: Partial<KellySizerDraft>) => void;
}): GridField[] {
  if (mode === "scenario") {
    const scenario = draft as ScenarioKellyAssumptions;
    const updateOutcome = (index: number, patch: Partial<ScenarioKellyAssumptions["outcomes"][number]>) => {
      updateDraft({
        outcomes: scenario.outcomes.map((outcome, outcomeIndex) => (
          outcomeIndex === index ? { ...outcome, ...patch } : outcome
        )),
      } as Partial<KellySizerDraft>);
    };
    return scenario.outcomes.flatMap((outcome, index): GridField[] => [
      {
        id: `${outcome.id}:p`,
        label: `${outcome.label} p`,
        value: outcome.probability,
        percent: true,
        onValue: (value) => updateOutcome(index, { probability: value }),
      },
      {
        id: `${outcome.id}:ret`,
        label: `${outcome.label} ret`,
        value: outcome.returnPct,
        percent: true,
        allowNegative: true,
        tone: outcome.returnPct >= 0 ? "positive" : "negative",
        onValue: (value) => updateOutcome(index, { returnPct: value }),
      },
    ]);
  }

  if (mode === "risk-budget") {
    const risk = draft as KellySizerModeDrafts["risk-budget"];
    return [
      {
        id: "riskBudget",
        label: "Risk budget",
        value: risk.riskBudgetFraction,
        percent: true,
        onValue: (value) => updateDraft({ riskBudgetFraction: value } as Partial<KellySizerDraft>),
      },
      {
        id: "downside",
        label: "Downside",
        value: risk.downsideReturn,
        percent: true,
        allowNegative: true,
        tone: "negative",
        onValue: (value) => updateDraft({ downsideReturn: value } as Partial<KellySizerDraft>),
      },
      {
        id: "winProbability",
        label: "Win p",
        value: risk.winProbability,
        percent: true,
        onValue: (value) => updateDraft({ winProbability: value } as Partial<KellySizerDraft>),
      },
      {
        id: "upside",
        label: "Upside",
        value: risk.upsideReturn,
        percent: true,
        tone: "positive",
        onValue: (value) => updateDraft({ upsideReturn: value } as Partial<KellySizerDraft>),
      },
    ];
  }

  if (mode === "prediction-market") {
    // Side is the query bar's mode switch, not an input cell.
    const market = draft as KellySizerModeDrafts["prediction-market"];
    return [
      {
        id: "estimatedProbability",
        label: "Est p",
        value: market.estimatedProbability,
        percent: true,
        onValue: (value) => updateDraft({ estimatedProbability: value } as Partial<KellySizerDraft>),
      },
      {
        id: "marketPrice",
        label: "Price",
        value: market.marketPrice,
        percent: true,
        onValue: (value) => updateDraft({ marketPrice: value } as Partial<KellySizerDraft>),
      },
    ];
  }

  if (mode === "asymmetric") {
    const asymmetric = draft as KellySizerModeDrafts["asymmetric"];
    return [
      {
        id: "winProbability",
        label: "Win p",
        value: asymmetric.winProbability,
        percent: true,
        onValue: (value) => updateDraft({ winProbability: value } as Partial<KellySizerDraft>),
      },
      {
        id: "targetReturn",
        label: "Target",
        value: asymmetric.targetReturn,
        percent: true,
        tone: "positive",
        onValue: (value) => updateDraft({ targetReturn: value } as Partial<KellySizerDraft>),
      },
      {
        id: "maxLossReturn",
        label: "Max loss",
        value: asymmetric.maxLossReturn,
        percent: true,
        allowNegative: true,
        tone: "negative",
        onValue: (value) => updateDraft({ maxLossReturn: value } as Partial<KellySizerDraft>),
      },
    ];
  }

  const binary = draft as KellySizerModeDrafts["binary"];
  return [
    {
      id: "winProbability",
      label: "Win p",
      value: binary.winProbability,
      percent: true,
      onValue: (value) => updateDraft({ winProbability: value } as Partial<KellySizerDraft>),
    },
    {
      id: "upside",
      label: "Upside",
      value: binary.upsideReturn,
      percent: true,
      tone: "positive",
      onValue: (value) => updateDraft({ upsideReturn: value } as Partial<KellySizerDraft>),
    },
    {
      id: "downside",
      label: "Downside",
      value: binary.downsideReturn,
      percent: true,
      allowNegative: true,
      tone: "negative",
      onValue: (value) => updateDraft({ downsideReturn: value } as Partial<KellySizerDraft>),
    },
  ];
}

export function buildCommonFields({
  common,
  updateCommon,
}: {
  common: KellyCommonAssumptions;
  updateCommon: (patch: Partial<KellyCommonAssumptions>) => void;
}): GridField[] {
  return [
    {
      id: "common:kellyFraction",
      label: "Kelly",
      value: common.kellyFraction,
      percent: true,
      onValue: (value) => updateCommon({ kellyFraction: value }),
    },
    {
      id: "common:maxLoss",
      label: "Loss cap",
      value: common.maxLossFraction,
      percent: true,
      onValue: (value) => updateCommon({ maxLossFraction: value }),
    },
    {
      id: "common:maxName",
      label: "Name cap",
      value: common.maxNameFraction,
      percent: true,
      onValue: (value) => updateCommon({ maxNameFraction: value }),
    },
  ];
}
