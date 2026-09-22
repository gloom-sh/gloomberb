import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { buildScenario, type ScenarioModel } from "./model";

export interface ScenarioEvidenceInput {
  scenario: ScenarioModel | null | undefined;
  view: string;
  loading: boolean;
  error?: string | null;
  notices?: readonly string[];
}

export interface ScenarioEvidence {
  kind: "options-scenario";
  version: 1;
  symbol: string;
  view: string;
  loading: boolean;
  complete: boolean;
  error: string | null;
  notices: string[];
  plottedValueCount: number;
  scenario: ScenarioModel | null;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function observationCount(scenario: ScenarioModel, view: string): number {
  if (view === "payoff") return scenario.payoff.length * 2;
  if (view === "grid") return scenario.grid.reduce((count, row) => count + row.values.length, 0);
  if (view === "legs") return scenario.position.legs.length;
  return 0;
}

/** Uses the active pane's actual chart, table and position inputs. */
export function scenarioSemanticEvidence(input: ScenarioEvidenceInput): ScenarioEvidence {
  const scenario = input.scenario ?? null;
  const count = scenario ? observationCount(scenario, input.view) : 0;
  return { kind: "options-scenario", version: 1, symbol: scenario?.position.symbol ?? "", view: input.view,
    loading: input.loading, complete: !!scenario && count > 0 && !input.loading && !input.error,
    error: input.error ?? null, notices: [...(input.notices ?? [])], plottedValueCount: count, scenario };
}

export function useScenarioEvidence(input: ScenarioEvidenceInput): void {
  useRemoteUiNode({ role: "chart-data", label: "Rendered option scenario observations",
    getMetadata: () => ({ ...scenarioSemanticEvidence(input) }) });
}

/** Reprice both curves and every grid cell before accepting numeric screenshot evidence. */
export function readScenarioEvidence(value: unknown): ScenarioEvidence | null {
  if (!record(value) || value.kind !== "options-scenario" || value.version !== 1
    || typeof value.symbol !== "string" || !["payoff", "grid", "legs"].includes(String(value.view))
    || typeof value.loading !== "boolean" || typeof value.complete !== "boolean"
    || (value.error !== null && typeof value.error !== "string") || !strings(value.notices)
    || !record(value.scenario) || !strings(value.scenario.warnings)) return null;
  const scenario = value.scenario as unknown as ScenarioModel;
  let expected: ScenarioModel;
  try { expected = buildScenario(scenario.position, scenario.controls); } catch { return null; }
  if (value.symbol !== expected.position.symbol) return null;
  // A clamped requested date can add a warning to the original model. Its
  // normalized controls reproduce the values, while retaining that warning.
  const fields = ["controls", "valuation", "expiryRisk", "dates", "grid", "payoff", "expiryDate"] as const;
  if (fields.some((key) => JSON.stringify(scenario[key]) !== JSON.stringify(expected[key]))) return null;
  const count = observationCount(expected, String(value.view));
  if (count <= 0 || value.plottedValueCount !== count
    || value.complete !== (!value.loading && !value.error)) return null;
  return value as unknown as ScenarioEvidence;
}
