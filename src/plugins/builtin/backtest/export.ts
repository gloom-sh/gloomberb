import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { exportRowsTable, renderReportCsv, reportFooterLines, type CliReportTable } from "../../../cli/report-tables";
import type { HeadlessBundleResult } from "../../../types/headless";
import { BACKTEST_FRESHNESS } from "./report";

/**
 * The file the pane's Export CSV writes: what `fn BT <symbol> --csv --equity`
 * prints for the same run, from a report built with `equity`. The daily
 * curve at full precision, every row naming its symbol, currency, interval,
 * source and as-of, then the source lines and notes. Built from the same
 * tables and footer as the CLI, so the two differ only in their retrieval time.
 */
export function backtestEquityCsv(report: HeadlessBundleResult, symbol: string, now = Date.now()): string {
  const freshness = deriveHeadlessFreshness({ shape: "bundle", freshness: BACKTEST_FRESHNESS }, report, now);
  const tables = report.sections.flatMap((section): CliReportTable[] => {
    if (!section.rows) return [];
    const table = exportRowsTable(section.title, section.columns ?? [], section.rows);
    return [{
      ...table,
      identity: { ...(section.unit ? { currencyOrUnit: section.unit } : {}), ...(section.interval ? { interval: section.interval } : {}) },
    }];
  });
  const footer = reportFooterLines({ freshness, notes: report.notes ?? [] });
  return `${renderReportCsv({ tables, identity: { symbolOrSeries: symbol }, footer }, freshness)}\n`;
}
