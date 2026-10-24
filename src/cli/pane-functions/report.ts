import type { MarketContext } from "../types";
import type { NormalizedPaneFunctionOptions } from "./capabilities";
import type { ResolvedPaneFunction } from "./resolver";
import { buildHeadlessFunctionReport } from "./headless";
import { appendDomReportFooter, buildDomFunctionReport, domReportNote, domReportView } from "./dom";
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
  /** Report errors: a source that did not answer, a symbol that is not one. */
  errors?: string[];
  /** What the report could not do as asked and did instead; `fn` prints them on stderr and in JSON's `warnings`. */
  warnings?: string[];
  /**
   * Source, as-of in UTC and live/delayed/stale/not-a-feed status; the last
   * line of the text report. Absent when a wall covered the pane (`locked`),
   * since nothing was read.
   */
  freshness?: ReportFreshness;
  /** The wall that covered the whole pane, so the report read nothing. */
  locked?: "sign-in" | "pro";
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

/** `gloom shot CAT santander`, the argument quoted when it has spaces. */
function shotCommand(token: string, rawArg: string): string {
  const arg = rawArg.trim();
  return ["gloom shot", token, arg && /\s/.test(arg) ? JSON.stringify(arg) : arg].filter(Boolean).join(" ");
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
      throw new Error("HELP is an in-app pane, so it has no report. For the commands run `gloom help`; for the functions run `gloom catalog`.");
    }
    // A pane `shot` can draw is still one command away.
    const screenshot = resolved.capability.screenshotReadiness;
    if (screenshot != null && screenshot !== "unsupported") {
      throw new Error(`${resolved.token} is an interactive pane with no data report; run \`${shotCommand(resolved.token, rawArg)}\` to see it.`);
    }
    throw new Error(`${resolved.token} is an interactive pane and does not expose a data report.`);
  }

  const report = source === "headless"
    ? await buildHeadlessFunctionReport(resolved, context, rawArg)
    : await buildDomFunctionReport(resolved, context, rawArg);
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
  report.data = { ...report.data, source, elapsedMs };
  // A report about one symbol names it on every exported row; a chart's series name their own.
  if (!report.tables.identity && report.data.symbols.length === 1) {
    report.tables = { ...report.tables, identity: { symbolOrSeries: report.data.symbols[0]! } };
  }
  if (source === "dom") {
    const view = domReportView(report.data);
    report.text = appendDomReportFooter(report.text, elapsedMs, view, report.data.freshness);
    report.tables = {
      ...report.tables,
      footer: [...report.tables.footer, `note: ${domReportNote(elapsedMs, view)}`],
    };
  }
  return report;
}
