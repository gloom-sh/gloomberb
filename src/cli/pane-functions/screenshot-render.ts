import { logFailure } from "../../utils/log-failure";
import { apiClient } from "../../api-client";
import { loadResolvedHeadlessPaneModel, reportCoverage, reportGaps, type LoadedHeadlessPaneModel } from "./headless";
import { createOutputFolder, writeOutputFile } from "../output-file";
import type { Quote } from "../../types/financials";
import { isRecord } from "../../utils/guards";
import { savedCopyAt, savedCopyShownAt } from "../../data/saved-copies";
import {
  prepareDesktopPaneShotView,
  renderDesktopPaneScreenshot,
  type DesktopPaneShotBridge,
  type DesktopPaneShotPayload,
  type DesktopPaneShotRenderResult,
} from "../desktop-pane-shot";
import type { ResolvedPaneFunction } from "./resolver";
import type { MarketContext } from "../types";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import { declaredReportFreshness, renderedReportFreshness, renderedReportObservations, renderedReportOptions, rendersOwnStatus } from "./report-notices";
import {
  captureStatusLine,
  deriveCaptureReport,
  deriveHeadlessFreshness,
  deriveRenderedFreshness,
  statusDateEvidence,
  type CaptureReport,
  type CaptureStatusLine,
  type ReportFreshness,
} from "./freshness";
import { quotesFreshness } from "../freshness";
import { isCurrencyPairListing } from "../../utils/fx-market-hours";
import type { BrokerNameOf } from "../../market-data/quotes/export-identity";
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
function recordBridgedQuotes(bridge: DesktopPaneShotBridge, onSavedCopy?: (savedAt: number) => void): { bridge: DesktopPaneShotBridge; quotes: Quote[] } {
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
        // The page gets the answer as JSON, which drops its saved-copy mark: the report keeps when it was saved.
        const savedAt = savedCopyAt(result) ?? savedCopyShownAt(result);
        if (savedAt != null) onSavedCopy?.(savedAt);
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
  sourceName?: BrokerNameOf,
): CaptureStatusLine {
  const published = renderedReportFreshness(render.semanticUi ?? []);
  const declared = { ...declaredReportFreshness(resolved), ...published };
  const loaded = [
    ...payload.financials.map(([, financials]) => financials.quote),
    ...(payload.instrumentFinancials ?? []).map(({ financials }) => financials.quote),
    ...bridgedQuotes,
  ];
  // A rate the page converts by (USD/GBP beside an ADR and its home line) is no market of the capture's: its week's
  // Sunday reopen read as theirs (`reopens Sun 22:00 UTC` on SHEL:NYSE, which opens Mon 14:30 UTC). A page of rates keeps them.
  const listings = loaded.filter((quote) => quote && !isCurrencyPairListing(quote.symbol, quote.listingExchangeName || quote.exchangeName));
  const quotes = listings.length > 0 ? listings : loaded;
  // A pane that publishes the observations behind its figures (FXC's rates) dates itself.
  const observed = renderedReportObservations(render.semanticUi ?? []);
  // A view that dates its data in its own footer (a DES research tab's holdings) is not dated by the quotes either,
  // and the capture keeps that footer, unless the view publishes how current it is (OMON's chain), which its line says.
  const ownStatus = rendersOwnStatus(render.semanticUi ?? [])
    && !(declared.status || declared.asOf != null || declared.sources?.length || observed.length > 0);
  const quoted = declared.status || observed.length > 0 || ownStatus
    ? undefined
    // Quotes across markets name each one's session and open (`LSE opens Mon 08:00 UTC · US Mon 14:30 UTC`), as compare and QM do.
    : quotesFreshness(quotes, { ...declared.source ? { source: declared.source } : {}, datesEachVenue: true }, now, sourceName);
  // The footer such a view keeps says what its note would.
  const { note: _note, noteVariants: _noteVariants, ...unnoted } = declared;
  const line = captureStatusLine({
    report,
    selfDated: Object.keys(published).length > 0 || observed.length > 0,
    quoted,
    rendered: () => deriveRenderedFreshness(ownStatus ? unnoted : declared, {
      footerText: render.footerText ?? "",
      cellTimes: render.rows.flatMap((row) => row.cells.flatMap((cell) => (cell.instant ? [cell.instant] : []))),
      observed,
    }, now),
  });
  return ownStatus ? { ...line, ownStatus } : line;
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
 * The report options for what the capture shows, where that is not what it
 * was asked for: the tab it shows (`shownReportTab`), and the view the pane
 * says it stands in (`renderedReportOptions`: OVDV's stored close while the
 * chain is closed). Undefined when it shows what was asked.
 */
export function shownReportOptions(
  resolved: Pick<ResolvedPaneFunction, "headless" | "options">,
  semanticUi: readonly RemoteUiNodeSnapshot[],
): Record<string, string> | undefined {
  const tab = shownReportTab(resolved, semanticUi);
  const published = Object.entries(renderedReportOptions(semanticUi))
    .filter(([key, value]) => resolved.headless?.options.some((option) => option.key === key) && String(resolved.options[key] ?? "") !== value);
  return tab || published.length ? { ...tab ? { tab } : {}, ...Object.fromEntries(published) } : undefined;
}

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
  onlyUsable = false,
  onStalledReport,
  onDrawing,
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
  onlyUsable?: boolean;
  /**
   * Called when the report behind the status line was still loading at the
   * wait's end: the load was aborted, but a loader that ignores the signal
   * may keep the process alive.
   */
  onStalledReport?: () => void;
  /** Called once the pane's data is read and the page starts to draw it. */
  onDrawing?: () => void;
}): Promise<PaneScreenshotResult & { saved: boolean }> {
  prepareDesktopPaneShotView();
  if (captureImage) await createOutputFolder(outputPath);
  // The copies saved earlier the page drew from, where the data service did not answer.
  const savedCopies: number[] = [];
  const onSavedCopy = (savedAt: number) => { savedCopies.push(savedAt); };
  const apiProxy = { ...resolveDesktopShotApiProxy(context), onSavedCopy };
  const previousSessionToken = apiClient.getSessionToken();
  let payload: DesktopPaneShotPayload;
  let render: DesktopPaneShotRenderResult;
  let image: Uint8Array | undefined;
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
    // The report of what the capture shows, where that is another view than asked: loaded once, for its date and coverage.
    let shownModel: { key: string; load: () => Promise<LoadedHeadlessPaneModel> } | undefined;
    const shownLoader = (options: Record<string, string>) => {
      const key = JSON.stringify(options);
      if (shownModel?.key !== key) shownModel = { key, load: onceLoader(() => loadReport({ ...resolved, options: { ...resolved.options, ...options } })) };
      return shownModel.load;
    };
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
    onDrawing?.();
    const tab = payload.paneState[payload.paneId]?.activeTabId;
    if (!captureImage && resolved.template?.id === "new-ticker-detail-pane" && (!tab || tab === "overview")) payload.readTickerReport = true;
    if (statusLine && captureImage && shotHasStatusLine(resolved)) payload.statusLine = true;
    // A report reads the table's columns, not a picture of them: every one is drawn.
    if (!captureImage) payload.everyColumn = true;
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
    const recorded = recordBridgedQuotes(createDesktopShotBridge(context), onSavedCopy);
    const shotPayload = payload;
    ({ image, ...render } = await renderDesktopPaneScreenshot(payload, apiProxy, {
      captureImage,
      bridge: recorded.bridge,
      statusLine: async (rendered) => {
        if (shotLoadedNothing(rendered)) {
          abandonReports();
          return null;
        }
        const options = report && shownReportOptions(resolved, rendered.semanticUi);
        const shown = options ? reportShotFreshness(resolved, shownLoader(options)) : report;
        const line = shotFreshness(resolved, shotPayload, rendered, recorded.quotes, shown && await settledWithin(shown, SHOT_REPORT_WAIT_MS),
          Date.now(), context.dataProvider.sourceNameOf);
        abandonReports();
        freshness = line.freshness;
        // A row whose read failed is marked on the picture, where its figures are missing.
        const unread = unreadRowsNote(shotPayload.unreadRows);
        return { variants: unread ? line.variants.map((variant) => `${variant} · ${unread}`) : line.variants, dates: line.dates,
          dateEvidence: statusDateEvidence(line.freshness), ...(line.ownStatus ? { ownStatus: true } : {}) };
      },
    }));
    // A pane that shows another view than asked (a stored close while the chain is closed) covers that view's report.
    const shownOptions = captureImage ? shownReportOptions(resolved, render.semanticUi ?? []) : undefined;
    if (shownOptions) coverage = reportShotCoverage(resolved, shownLoader(shownOptions));
    covered = coverage && await settledWithin(coverage, SHOT_REPORT_WAIT_MS);
  } finally {
    apiClient.setSessionToken(previousSessionToken);
    abandonReports();
  }
  const renderedInstance = payload.config.layout.instances.find(({ instanceId }) => instanceId === payload.paneId);
  if (renderedInstance) resolved = { ...resolved, instance: renderedInstance };
  const assessed = withReportCoverage(assessPaneScreenshot(resolved, payload, render, rawArg, outputPath), covered);
  const save = image && (!onlyUsable || assessed.usable) ? image : undefined;
  if (save) await writeOutputFile(outputPath, save);
  const unreadRows = payload.unreadRows?.length ? { unreadRows: payload.unreadRows, ...(payload.unreadReasons ? { unreadReasons: payload.unreadReasons } : {}) } : {};
  return { ...assessed, ...unreadRows, saved: save !== undefined, ...(freshness ? { freshness } : {}),
    ...(savedCopies.length > 0 ? { savedCopyAt: Math.min(...savedCopies) } : {}) };
}

/** "FRC did not load": a list's rows whose read failed, as the capture's status line marks them. */
export function unreadRowsNote(rows: readonly string[] | undefined): string | null {
  if (!rows?.length) return null;
  const named = rows.length > 3 ? `${rows.slice(0, 3).join(", ")} and ${rows.length - 3} more` : rows.join(", ");
  return `${named} did not load`;
}
