import type { MarketContext } from "../types";
import type { NormalizedPaneFunctionOptions } from "./capabilities";
import type { ResolvedPaneFunction } from "./resolver";
import { buildHeadlessFunctionReport } from "./headless";
import { appendDomReportFooter, buildDomFunctionReport, domReportNote } from "./dom";
import type { ReportFreshness } from "./freshness";
import type { CliReportTables } from "../report-tables";

export type PaneFunctionReportSource = "headless" | "dom";

interface PaneFunctionReportData {
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
  /** Source, as-of in UTC and live/delayed/stale/not-a-feed status; the last line of the text report. */
  freshness: ReportFreshness;
  [key: string]: unknown;
}

export interface PaneFunctionReport {
  data: PaneFunctionReportData;
  text: string;
  /** What `--csv` and `--ndjson` write: the text view's tables as flat rows, and the closing `#` lines. */
  tables: CliReportTables;
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
    // HELP is what a newcomer tries first: send them to the command guide and the function list.
    if (resolved.pane.id === "help") {
      throw new Error("HELP is an in-app pane, so it has no report. For the commands run `gloomberb help`; for the functions run `gloomberb catalog`.");
    }
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
      report.data.freshness,
    );
    report.tables = {
      ...report.tables,
      footer: [...report.tables.footer, `note: ${domReportNote(elapsedMs, report.data.truncated === true)}`],
    };
  }
  return report;
}
