import type { DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { FundamentalPeriod } from "../../time-series/reporting";
import type { PaneScreenshotEvidence } from "./screenshot-evidence";
import type { ReportFreshness } from "./freshness";
import type { PaneScreenshotFinancialRatioEvidence } from "./financial-ratio-shot";

export interface PaneScreenshotExpectedSelection {
  control: "metric" | "statement" | "ratio" | "period";
  value?: string;
  label?: string;
}

export interface PaneScreenshotChartPointEvidence {
  date: string;
  close: number;
}

export interface PaneScreenshotChartSeriesEvidence {
  symbol: string;
  pointCount: number;
  first: PaneScreenshotChartPointEvidence | null;
  last: PaneScreenshotChartPointEvidence | null;
  projectionBaseValue?: number | null;
  projectionLatestRawValue?: number | null;
  projectionLatestValue?: number | null;
}

export interface PaneScreenshotExpectedChartEvidence {
  kind: "stock-price" | "price-comparison" | "chart-composer";
  symbols: string[];
  rangePreset: string;
  axisMode?: string;
  resolution?: string;
  sourceSeries?: PaneScreenshotChartSeriesEvidence[];
  baseSeries?: Array<{
    id: string;
    sourceKind: "security" | "economic" | "capability";
    symbol?: string;
    fieldId?: string;
    economicSeriesId?: string;
    capabilityId?: string;
    providerSeriesId?: string;
    first?: { date: string; value: number | null } | null;
    last?: { date: string; value: number | null } | null;
    style: string;
    transform: string;
    panelId: string;
    visible: boolean;
  }>;
}

interface PaneScreenshotPriceComparisonEvidence {
  kind: "price-comparison";
  symbols: string[];
  range: string;
  series: Array<{
    symbol: string;
    base: { date: string; value: number };
    latest: { date: string; value: number };
    returnPercent: number;
  }>;
}

interface PaneScreenshotPriceSeriesEvidence {
  kind: "price-series";
  symbol: string;
  range: string;
  pointCount: number;
  first: PaneScreenshotChartPointEvidence;
  last: PaneScreenshotChartPointEvidence;
  resolution?: string;
  sessionDates?: string[];
}

interface PaneScreenshotFundamentalSeriesEvidence {
  kind: "fundamental-series";
  metric: string;
  period: FundamentalPeriod;
  series: Array<{
    symbol: string;
    rows: Array<{ date: string; value: number }>;
  }>;
}

interface PaneScreenshotFinancialStatementEvidence {
  kind: "financial-statement";
  symbol: string;
  statement: string;
  period: FundamentalPeriod;
  latest: {
    date: string;
    metrics: Array<{
      id: string;
      key: string;
      label: string;
      value: number;
    }>;
  };
}

export type PaneScreenshotDataEvidence =
  | PaneScreenshotPriceSeriesEvidence
  | PaneScreenshotPriceComparisonEvidence
  | PaneScreenshotFundamentalSeriesEvidence
  | PaneScreenshotFinancialStatementEvidence
  | PaneScreenshotFinancialRatioEvidence
  | PaneScreenshotEvidence;

export interface PaneScreenshotReadinessSignals {
  /**
   * A surface to operate rather than data to read (Layouts, Brokers): its rows
   * and an empty-state marker inside it say nothing of whether it rendered.
   */
  interactive?: boolean;
  rowCount: number;
  loadingStateDetected: boolean;
  errorStateDetected: boolean;
  emptyStateDetected: boolean;
  complete: boolean;
  semanticMismatch: boolean;
  requiresStructuredDataEvidence: boolean;
  hasStructuredDataEvidence: boolean;
}

export interface PaneScreenshotResult {
  kind: "pane-screenshot";
  target: string;
  capability: {
    id: string;
    botSafe: boolean;
    outputKind: string;
    reportReadiness: ResolvedPaneFunction["capability"]["reportReadiness"];
    screenshotReadiness: ResolvedPaneFunction["capability"]["screenshotReadiness"];
  };
  symbols: string[];
  options: Record<string, string | number | boolean>;
  rowCount: number;
  empty: boolean;
  complete: boolean;
  unavailableSymbols: string[];
  semanticMismatch: boolean;
  usable: boolean;
  unusableReason: string | null;
  dataEvidence: PaneScreenshotDataEvidence | null;
  /** What the pane says its view leaves out, such as OMON's "21 of 145 strikes". */
  notices?: string[];
  /**
   * For a pane that grows to show every row (FUT): how many of the rows its
   * table reports the image shows, section headers left out. `shown` is less
   * than `total` when the height limit or `--height` cut the board.
   */
  tableRows?: { shown: number; total: number };
  /** What the pane's report leaves out when it is not complete, as `fn` words it: `2 stale`. */
  gaps?: string;
  /** How current the captured data is, as the capture's status line says it; absent with `--no-status`. */
  freshness?: ReportFreshness;
  outputPath: string;
  render: DesktopPaneShotRenderResult & {
    expectedText: string[];
    missingExpectedText: string[];
    expectedSelections: PaneScreenshotExpectedSelection[];
    missingExpectedSelections: PaneScreenshotExpectedSelection[];
    expectedChart: PaneScreenshotExpectedChartEvidence | null;
    chartEvidenceMismatches: string[];
  };
}
