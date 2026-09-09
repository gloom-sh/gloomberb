import type { MarketContext } from "../types";
import type { NormalizedPaneFunctionOptions } from "./capabilities";
import type { ResolvedPaneFunction } from "./resolver";
import { buildHeadlessFunctionReport } from "./headless";
import { appendDomReportFooter, buildDomFunctionReport } from "./dom";

export type PaneFunctionReportSource = "headless" | "dom";

export interface PaneFunctionReportData {
  kind: string;
  /** Added by buildFunctionReport after the selected loader completes. */
  source?: PaneFunctionReportSource;
  /** Added by buildFunctionReport for every successful report. */
  elapsedMs?: number;
  target: string;
  capabilityId: string;
  symbols: string[];
  options: NormalizedPaneFunctionOptions;
  rowCount: number;
  empty: boolean;
  complete: boolean;
  unavailableSymbols: string[];
  [key: string]: unknown;
}

export interface PaneFunctionReport {
  data: PaneFunctionReportData;
  text: string;
}

export function resolvePaneFunctionReportSource(
  resolved: Pick<ResolvedPaneFunction, "headless" | "capability">,
): PaneFunctionReportSource | null {
  if (resolved.headless) return "headless";
  return resolved.capability.reportReadiness === "live-dom" ? "dom" : null;
}

export async function buildFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<PaneFunctionReport> {
  const startedAt = performance.now();
  const source = resolvePaneFunctionReportSource(resolved);
  if (!source) {
    throw new Error(`${resolved.token} is an interactive pane and does not expose a data report.`);
  }

  const report = source === "headless"
    ? await buildHeadlessFunctionReport(resolved, context, rawArg)
    : await buildDomFunctionReport(resolved, context, rawArg);
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  report.data = { ...report.data, source, elapsedMs };
  if (source === "dom") {
    report.text = appendDomReportFooter(
      report.text,
      elapsedMs,
      report.data.truncated === true,
    );
  }
  return report;
}
