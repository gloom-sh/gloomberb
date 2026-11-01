import { logFailure } from "../../utils/log-failure";
import { apiClient } from "../../api-client";
import { loadResolvedHeadlessPaneModel, reportCoverage, reportGaps, type LoadedHeadlessPaneModel } from "./headless";
import { createOutputFolder } from "../output-file";
import type { Quote } from "../../types/financials";
import { isRecord } from "../../utils/guards";
import {
  renderDesktopPaneScreenshot,
  type DesktopPaneShotBridge,
  type DesktopPaneShotPayload,
  type DesktopPaneShotRenderResult,
} from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { MarketContext } from "../types";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import { declaredReportFreshness, renderedReportFreshness, renderedReportObservations } from "./report-notices";
import {
  captureStatusLine,
  deriveCaptureReport,
  deriveHeadlessFreshness,
  deriveRenderedFreshness,
  type CaptureReport,
  type CaptureStatusLine,
  type ReportFreshness,
} from "./freshness";
import { quotesFreshness } from "../freshness";
import { paneFitsRows, shotMaxHeightCells, buildDesktopShotPayload } from "./screenshot-payload";
import { resolveDesktopShotApiProxy, createDesktopShotBridge } from "./screenshot-bridge";
import type { PaneScreenshotResult } from "./screenshot-types";
import { assessPaneScreenshot, shotLoadedNothing } from "./screenshot-assessment";

/**
 * Whether a capture's footer keeps a row for the dated status line. A pane of
 * the user's own state (notes, connections, documentation) declares `local`:
 * it has no data to date, and "not a live feed" would be said of its own
 * state. A capture that loaded nothing gives the row back later
 * (`shotLoadedNothing`).
 */
export function shotHasStatusLine(resolved: Pick<ResolvedPaneFunction, "pane" | "template">): boolean {
  return !declaredReportFreshness(resolved).local;
}

/** The bridge, keeping every quote it serves the page: what a pane that loads its own quotes (WEI) shows. */
function recordBridgedQuotes(bridge: DesktopPaneShotBridge): { bridge: DesktopPaneShotBridge; quotes: Quote[] } {
  const quotes: Quote[] = [];
  const keep = (value: unknown) => {
    if (isRecord(value) && typeof value.symbol === "string" && typeof value.price === "number") quotes.push(value as unknown as Quote);
  };
  return {
    quotes,
    bridge: {
      ...bridge,
      async marketData(operation, args) {
        const result = await bridge.marketData(operation, args);
        if (operation === "getQuote") keep(result);
        if (operation === "getQuotesBatch" && Array.isArray(result)) {
          for (const entry of result) keep(isRecord(entry) ? entry.quote : null);
        }
        return result;
      },
    },
  };
}

/**
 * How current a capture's data is (`captureStatusLine`). A pane that dates its
 * view itself (the news wire's delay, FXC's rates) is taken at its word, and so
 * is a report that says what its data is (EE's estimates, MDAY's study): the
 * quotes the page loaded beside them do not date them. A pane that declares a
 * status is never dated by the quotes it shows; otherwise those quotes date it,
 * with their delay and where their markets stand. Then the pane's report, as
 * `fn` ends; then what the rendered view carries. A function that opens one
 * view of a pane hosting several declares it on its template (DDIS in Fixed
 * Income), so its filings, not the issuer's stock quote, date the capture.
 */
export function shotFreshness(
  resolved: Pick<ResolvedPaneFunction, "pane" | "template">,
  payload: Pick<DesktopPaneShotPayload, "financials" | "instrumentFinancials">,
  render: Pick<DesktopPaneShotRenderResult, "semanticUi" | "footerText" | "rows">,
  bridgedQuotes: readonly Quote[],
  report: CaptureReport | undefined,
  now = Date.now(),
): CaptureStatusLine {
  const published = renderedReportFreshness(render.semanticUi ?? []);
  const declared = { ...declaredReportFreshness(resolved), ...published };
  const quotes = [
    ...payload.financials.map(([, financials]) => financials.quote),
    ...(payload.instrumentFinancials ?? []).map(({ financials }) => financials.quote),
    ...bridgedQuotes,
  ];
  // A pane that publishes the observations behind its figures (FXC's rates) dates itself.
  const observed = renderedReportObservations(render.semanticUi ?? []);
  const quoted = declared.status || observed.length > 0
    ? undefined
    : quotesFreshness(quotes, declared.source ? { source: declared.source } : undefined, now);
  return captureStatusLine({
    report,
    selfDated: Object.keys(published).length > 0 || observed.length > 0,
    quoted,
    rendered: () => deriveRenderedFreshness(declared, {
      footerText: render.footerText ?? "",
      cellTimes: render.rows.flatMap((row) => row.cells.flatMap((cell) => (cell.instant ? [cell.instant] : []))),
      observed,
    }, now),
  });
}

/**
 * A capture's data dated as its `fn` report dates it, from the same loader:
 * COT's weekly report, CHOKE's transits, GPU's prices. Undefined for a pane
 * without a report, or when it did not load.
 */
async function reportShotFreshness(
  resolved: Pick<ResolvedPaneFunction, "headless">,
  loadModel: () => Promise<LoadedHeadlessPaneModel>,
  now = Date.now(),
): Promise<CaptureReport | undefined> {
  if (!resolved.headless) return undefined;
  try {
    const loaded = await loadModel();
    return deriveCaptureReport(loaded.definition, loaded.result, now);
  } catch (error) {
    logFailure("cli.screenshot", "Read screenshot report freshness failed")(error);
    return undefined;
  }
}

/** What a capture's report says about its own completeness (`fn`'s `complete`), as `reportCoverage` derives it. */
export interface ShotReportCoverage {
  complete: boolean;
  unavailableSymbols: string[];
  gaps?: string;
}

/**
 * Whether the pane's report covers what was asked, loaded once with the
 * capture's other uses of it. Undefined for a pane without a report, or when
 * it did not load.
 */
export async function reportShotCoverage(
  resolved: Pick<ResolvedPaneFunction, "headless">,
  loadModel: () => Promise<LoadedHeadlessPaneModel>,
): Promise<ShotReportCoverage | undefined> {
  if (!resolved.headless) return undefined;
  try {
    const loaded = await loadModel();
    const { complete, unavailableSymbols } = reportCoverage(loaded);
    const gaps = reportGaps(loaded, deriveHeadlessFreshness(loaded.definition, loaded.result));
    return { complete, unavailableSymbols, ...(gaps ? { gaps } : {}) };
  } catch (error) {
    logFailure("cli.screenshot", "Read screenshot report coverage failed")(error);
    return undefined;
  }
}

/**
 * The capture's result with its report's completeness: a capture of a partial
 * report is partial too, whatever the rendered view shows. Whether the image
 * is fit to use stays what the render says.
 */
export function withReportCoverage(result: PaneScreenshotResult, coverage: ShotReportCoverage | undefined): PaneScreenshotResult {
  if (!coverage || coverage.complete) return result;
  return {
    ...result,
    complete: false,
    unavailableSymbols: [...new Set([...result.unavailableSymbols, ...coverage.unavailableSymbols])],
    ...(coverage.gaps ? { gaps: coverage.gaps } : {}),
  };
}

/** How long a rendered capture waits for its report's freshness before dating itself without it. */
const SHOT_REPORT_WAIT_MS = 20_000;

/**
 * The value of the report's `tab` option for the tab the capture shows, when
 * it was asked for another: `DOE --tab all` draws Crude, so it is dated by
 * Wednesday's petroleum report, not by Thursday's gas storage. Undefined when
 * it shows the tab asked for.
 */
export function shownReportTab(
  resolved: Pick<ResolvedPaneFunction, "headless" | "options">,
  semanticUi: readonly RemoteUiNodeSnapshot[],
): string | undefined {
  const asked = resolved.options.tab;
  const values = resolved.headless?.options?.find(({ key }) => key === "tab")?.values?.map(({ value }) => value) ?? [];
  if (asked == null || values.length === 0) return undefined;
  for (const node of semanticUi) {
    const active = node.role === "tabs" ? node.metadata?.activeValue : undefined;
    if (typeof active === "string" && values.includes(active)) return active === String(asked) ? undefined : active;
  }
  return undefined;
}

/** `pending`'s value, or undefined when it has not settled within `ms`; a later result is dropped. */
function settledWithin<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  let cancel = () => {};
  const expired = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    cancel = () => clearTimeout(timer);
  });
  return Promise.race([pending, expired]).finally(() => cancel());
}

/** One load of the pane's report per capture, shared by the payload and the status line. */
function onceLoader(load: () => Promise<LoadedHeadlessPaneModel>): () => Promise<LoadedHeadlessPaneModel> {
  let pending: Promise<LoadedHeadlessPaneModel> | undefined;
  return () => (pending ??= load());
}

export async function renderDesktopShot({
  resolved,
  context,
  rawArg,
  outputPath,
  width,
  height,
  theme,
  scale,
  watermark,
  statusLine = false,
  fitRows = false,
  fitReader = false,
  maxHeightCells,
  options,
  captureImage = true,
  onStalledReport,
}: {
  resolved: ResolvedPaneFunction;
  context: MarketContext;
  rawArg: string;
  outputPath: string;
  width: number;
  height: number;
  theme?: string | null;
  scale?: number;
  watermark?: string | null;
  /** Draw the dated status line in the capture's footer. Reports and `--no-status` leave it out. */
  statusLine?: boolean;
  /** No `--height` was asked for: a pane that fits its rows (FUT) grows to show them all. */
  fitRows?: boolean;
  /** A pane whose reader has a page open grows to show all of its text (a report's, which saves no image). */
  fitReader?: boolean;
  /** How tall a pane that fits its rows or its reader may grow, in cells, where the height limit of a saved image does not apply. */
  maxHeightCells?: number;
  options: Record<string, string | true>;
  captureImage?: boolean;
  /**
   * Called when the report behind the status line was still loading at the
   * wait's end: the load was aborted, but a loader that ignores the signal
   * may keep the process alive.
   */
  onStalledReport?: () => void;
}): Promise<PaneScreenshotResult> {
  if (captureImage) await createOutputFolder(outputPath);
  const apiProxy = resolveDesktopShotApiProxy(context);
  const previousSessionToken = apiClient.getSessionToken();
  let payload: DesktopPaneShotPayload;
  let render: DesktopPaneShotRenderResult;
  let freshness: ReportFreshness | undefined;
  let coverage: Promise<ShotReportCoverage | undefined> | undefined;
  let covered: ShotReportCoverage | undefined;
  // A report still loading when the status line stops waiting for it is
  // aborted, and the caller told: a loader that ignores the signal goes on.
  const reportLoads = new AbortController();
  let loading = 0;
  const loadReport = (target: ResolvedPaneFunction) => {
    loading += 1;
    return loadResolvedHeadlessPaneModel(target, context, rawArg, reportLoads.signal).finally(() => { loading -= 1; });
  };
  const abandonReports = () => {
    if (loading === 0 || reportLoads.signal.aborted) return;
    reportLoads.abort(new Error("The capture stopped waiting for its report."));
    onStalledReport?.();
  };
  apiClient.setSessionToken(apiProxy.sessionToken);
  try {
    const loadModel = onceLoader(() => loadReport(resolved));
    payload = await buildDesktopShotPayload(
      resolved,
      context,
      rawArg,
      options,
      width,
      height,
      theme ?? null,
      scale ?? 1,
      watermark ?? null,
      loadModel,
    );
    if (statusLine && captureImage && shotHasStatusLine(resolved)) payload.statusLine = true;
    const fitRoles = [
      ...(fitRows && paneFitsRows(resolved) ? ["data-table-body-scroll"] : []),
      ...(fitReader && resolved.pane.shotFitsReader ? ["detail-scroll-body"] : []),
    ];
    if (fitRoles.length > 0) {
      payload.maxHeightCells = maxHeightCells ?? shotMaxHeightCells(scale ?? 1);
      payload.fitRoles = fitRoles;
    }
    // Loads while the page renders.
    const report = payload.statusLine ? reportShotFreshness(resolved, loadModel) : undefined;
    // The same load says whether the report is complete, with or without a status line.
    coverage = captureImage ? reportShotCoverage(resolved, loadModel) : undefined;
    const recorded = recordBridgedQuotes(createDesktopShotBridge(context));
    const shotPayload = payload;
    render = await renderDesktopPaneScreenshot(payload, outputPath, apiProxy, {
      captureImage,
      bridge: recorded.bridge,
      statusLine: async (rendered) => {
        if (shotLoadedNothing(rendered)) {
          abandonReports();
          return null;
        }
        const tab = report && shownReportTab(resolved, rendered.semanticUi);
        const shown = tab ? reportShotFreshness(resolved, () => loadReport({ ...resolved, options: { ...resolved.options, tab } })) : report;
        const line = shotFreshness(resolved, shotPayload, rendered, recorded.quotes, shown && await settledWithin(shown, SHOT_REPORT_WAIT_MS));
        abandonReports();
        freshness = line.freshness;
        return { variants: line.variants, dates: line.dates };
      },
    });
    covered = coverage && await settledWithin(coverage, SHOT_REPORT_WAIT_MS);
  } finally {
    apiClient.setSessionToken(previousSessionToken);
    abandonReports();
  }
  const renderedInstance = payload.config.layout.instances.find(({ instanceId }) => instanceId === payload.paneId);
  if (renderedInstance) resolved = { ...resolved, instance: renderedInstance };
  const assessed = withReportCoverage(assessPaneScreenshot(resolved, payload, render, rawArg, outputPath), covered);
  return freshness ? { ...assessed, freshness } : assessed;
}
