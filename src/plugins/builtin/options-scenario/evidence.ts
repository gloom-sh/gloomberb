import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type { TickerFinancials } from "../../../types/financials";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { buildScenario, type ScenarioControls, type ScenarioModel, type ScenarioPosition } from "./model";
import { isRecord, isStringArray } from "../../../utils/guards";

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
  if (!isRecord(value) || value.kind !== "options-scenario" || value.version !== 1
    || typeof value.symbol !== "string" || !["payoff", "grid", "legs"].includes(String(value.view))
    || typeof value.loading !== "boolean" || typeof value.complete !== "boolean"
    || (value.error !== null && typeof value.error !== "string") || !isStringArray(value.notices)
    || !isRecord(value.scenario) || !isStringArray(value.scenario.warnings)) return null;
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

export const scenarioScreenshotEvidence: PaneScreenshotEvidenceHook<ScenarioEvidence> = {
  paneId: "options-scenario",
  kind: "options-scenario",
  label: "option scenario",
  read: readScenarioEvidence,
  async prepare({ loadModel }) {
    // Freeze the same user inputs and market observations used by the report.
    // A typed strategy with an explicit spot needs no unrelated financials fetch.
    const loaded = await loadModel();
    const metadata = loaded.result.metadata as {
      scenario?: ScenarioModel | null;
      position?: ScenarioPosition | null;
      controls?: ScenarioControls | null;
      market?: unknown;
      inputSource?: string;
    } | undefined;
    const position = metadata?.position;
    const controls = metadata?.controls;
    const symbol = position?.symbol ?? loaded.args.symbols[0];
    const data: TickerFinancials = { annualStatements: [], quarterlyStatements: [], priceHistory: [],
      ...(position && symbol ? { quote: { symbol, price: position.spot, currency: position.currency,
        change: 0, changePercent: 0, lastUpdated: position.asOf,
        providerId: metadata?.inputSource === "user" ? "user-input" : "scenario-snapshot", dataSource: "snapshot" as const } } : {}) };
    return {
      settings: {
        scenarioSnapshot: metadata?.scenario ?? null,
        scenarioMarketSnapshot: metadata?.market ?? null,
        scenarioSnapshotErrors: loaded.result.errors ?? [],
        ...(position ? { seedPosition: position } : {}),
        ...(controls ? { date: new Date(controls.date).toISOString(), volShift: controls.volShift * 100,
          spotRange: controls.spotRange * 100 } : {}),
      },
      financials: symbol ? [[symbol, data]] : [],
    };
  },
  /** Validate the active scenario against the immutable inputs consumed by the pane. */
  mismatches(evidence, { resolved, payload }) {
    const mismatches: string[] = [];
    const settings = payload.config?.layout?.instances.find((entry) => entry.instanceId === payload.paneId)?.settings
      ?? resolved.instance?.settings ?? {};
    const symbol = resolved.createOptions?.symbol ?? payload.financials[0]?.[0];
    if (symbol && parsePublicTickerKey(evidence.symbol).symbol !== parsePublicTickerKey(symbol).symbol) {
      mismatches.push("rendered option scenario symbol does not match");
    }
    if (evidence.view !== (resolved.options.tab ?? "payoff")) mismatches.push("rendered option scenario view does not match");
    if (settings.scenarioSnapshot && JSON.stringify(evidence.scenario) !== JSON.stringify(settings.scenarioSnapshot)) {
      mismatches.push("rendered option scenario inputs or values do not match");
    }
    return mismatches;
  },
  unavailable(evidence, { resolved }) {
    return evidence?.complete && !evidence.loading ? [] : [evidence?.symbol ?? resolved.createOptions?.symbol ?? "option scenario"];
  },
};
