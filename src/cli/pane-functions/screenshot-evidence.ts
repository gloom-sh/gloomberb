import { powerScreenshotEvidence } from "../../plugins/builtin/power/evidence";
import { supplyScreenshotEvidence } from "../../plugins/builtin/supply-chain/evidence";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import type { TickerFinancials } from "../../types/financials";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import type { MarketContext } from "../types";
import type { LoadedHeadlessPaneModel } from "./headless";
import type { ResolvedPaneFunction } from "./resolver";
import { calculatorScreenshotEvidence } from "../../plugins/builtin/options-calculator/evidence";
import { scenarioScreenshotEvidence } from "../../plugins/builtin/options-scenario/evidence";
import { realizedVolScreenshotEvidence } from "../../plugins/builtin/realized-vol/evidence";
import { volSurfaceScreenshotEvidence } from "../../plugins/builtin/vol-surface/evidence";
import { volatilityScreenshotEvidence } from "../../plugins/builtin/volatility/evidence";

/** The envelope every pane's rendered chart-data evidence carries. */
export interface PaneScreenshotEvidence {
  kind: string;
  version: number;
  complete: boolean;
  plottedValueCount: number;
}

interface PaneScreenshotEvidenceRequest {
  resolved: ResolvedPaneFunction;
  payload: DesktopPaneShotPayload;
}

interface PaneScreenshotPrepareInput {
  resolved: ResolvedPaneFunction;
  context: MarketContext;
  /** The captured instance settings, already stripped of credentials. */
  settings: Record<string, unknown>;
  loadModel(): Promise<LoadedHeadlessPaneModel>;
}

interface PaneScreenshotPrepared {
  /** Merged into the captured instance settings. */
  settings: Record<string, unknown>;
  /** Market data the page treats as captured, one entry per symbol. */
  financials?: Array<[string, TickerFinancials]>;
}

/**
 * How `gloomberb shot` certifies a pane that publishes a `chart-data` semantic
 * node. The pane owns its evidence format; the CLI only accepts what `read`
 * re-derives and checks it against the request here.
 */
export interface PaneScreenshotEvidenceHook<E extends PaneScreenshotEvidence = PaneScreenshotEvidence> {
  paneId: string;
  /** The `kind` of the chart-data node the pane publishes. */
  kind: E["kind"];
  /** Names the pane in mismatch messages. */
  label: string;
  /** Evidence re-derived from the node metadata, or null when it cannot be trusted. */
  read(metadata: unknown): E | null;
  /** Ways the rendered evidence differs from what the command requested. */
  mismatches(evidence: E, request: PaneScreenshotEvidenceRequest): string[];
  /** Symbols or sources that did not finish loading; empty once complete. */
  unavailable(evidence: E | null, request: PaneScreenshotEvidenceRequest): string[];
  /** Freezes the pane's inputs before rendering, so the capture and the verifier agree. */
  prepare?(input: PaneScreenshotPrepareInput): Promise<PaneScreenshotPrepared>;
  /** Symbols the result names, or null to use the captured market data. */
  symbols?(request: PaneScreenshotEvidenceRequest): string[] | null;
  /** Text the capture must show beyond the symbols. */
  expectedText?(request: PaneScreenshotEvidenceRequest): string[];
  /** Labeled values a capture must show unclipped. */
  visibleLabels?: readonly string[];
}

/** Built-in panes that certify their captures with their own evidence. */
const PANE_SCREENSHOT_EVIDENCE: readonly PaneScreenshotEvidenceHook[] = [
  supplyScreenshotEvidence,
  powerScreenshotEvidence,
  calculatorScreenshotEvidence,
  scenarioScreenshotEvidence,
  realizedVolScreenshotEvidence,
  volSurfaceScreenshotEvidence,
  volatilityScreenshotEvidence,
];

export function paneScreenshotEvidenceHook(resolved: ResolvedPaneFunction): PaneScreenshotEvidenceHook | null {
  return PANE_SCREENSHOT_EVIDENCE.find((hook) => hook.paneId === resolved.pane?.id) ?? null;
}

export function renderedPaneEvidence(
  hook: PaneScreenshotEvidenceHook,
  semanticUi: RemoteUiNodeSnapshot[],
): PaneScreenshotEvidence | null {
  return hook.read(semanticUi.find((node) => node.role === "chart-data" && node.metadata?.kind === hook.kind)?.metadata);
}

/** Ways a pane's rendered evidence differs from the request; empty for panes without a hook. */
export function paneEvidenceMismatches(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  render: Pick<DesktopPaneShotRenderResult, "semanticUi" | "visibleKeyValues">,
): string[] {
  const hook = paneScreenshotEvidenceHook(resolved);
  if (!hook) return [];
  const evidence = renderedPaneEvidence(hook, render.semanticUi);
  const mismatches = evidence
    ? hook.mismatches(evidence, { resolved, payload })
    : [`rendered ${hook.label} data evidence is missing or invalid`];
  if (hook.visibleLabels) {
    const visible = new Set((render.visibleKeyValues ?? []).map((row) => row.label));
    const missing = hook.visibleLabels.filter((label) => !visible.has(label));
    if (missing.length) mismatches.push(`${hook.label} metrics are clipped or missing: ${missing.join(", ")}`);
  }
  return mismatches;
}
