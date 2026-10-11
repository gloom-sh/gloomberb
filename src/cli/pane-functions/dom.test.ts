import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { ResolvedPaneFunction } from "./resolver";
import { assessPaneScreenshot, type PaneScreenshotResult } from "./screenshot";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderResult } from "../desktop-pane-shot";
import { buildDomPaneReportFromRender } from "./dom";
import { renderReportCsv } from "../report-tables";
import { formatFreshnessLine } from "./freshness";

// The status line names the year only when it is not the current one.
beforeAll(() => setSystemTime(new Date("2026-10-10T12:00:00Z")));
afterAll(() => setSystemTime());

test("marks rendered reports as truncated when a visible cell contains an ellipsis", () => {
  const resolved = {
    token: "INS",
    label: "Insider",
    pane: { id: "insider" },
    capability: { id: "insider-pane" },
    options: {},
  } as unknown as ResolvedPaneFunction;
  const screenshot = {
    symbols: ["AVGO"],
    render: {
      visibleText: "NVIDIA Corporati…",
      rows: [{
        tableIndex: 0,
        rowIndex: 0,
        selected: false,
        cells: [{ columnLabel: "Issuer", text: "NVIDIA Corporati…" }],
      }],
      truncated: false,
      truncationReasons: [],
      loadingStateDetected: false,
      errorStateDetected: false,
      errorStateMarkers: [],
      emptyStateDetected: false,
      emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = buildDomPaneReportFromRender(resolved, screenshot);
  expect(report.data).toMatchObject({
    kind: "rendered-view",
    rowCount: 1,
    truncated: true,
    complete: false,
    limitation: expect.stringContaining("visible"),
  });
});

test("keeps a cell under its own column when an earlier cell in the row is blank, and prints shortened times whole", () => {
  const resolved = {
    token: "TOP", label: "Top News", options: {}, capability: { id: "news-top-pane" },
    pane: { id: "news-top", reportFreshness: { status: "not-a-feed", basis: "published stories" } },
  } as unknown as ResolvedPaneFunction;
  const cell = (columnId: string, columnLabel: string, text: string, instant?: string) => ({ columnId, columnLabel, text, ...(instant ? { instant } : {}) });
  const screenshot = {
    symbols: [],
    render: {
      visibleText: "",
      footerText: "15m delayed",
      rows: [
        // The pane shortens times to fit; the cell keeps the instant behind them.
        { tableIndex: 0, rowIndex: 0, selected: false, cells: [cell("time", "TIME", "Wed 11:27", "2026-10-07T11:27:00.000Z"), cell("title", "HEADLINE", "Deal"), cell("tickers", "TICKERS", "PSKY"), cell("categories", "CATEGORY", "M&A")] },
        // The DOM capture drops the blank TICKERS cell.
        { tableIndex: 0, rowIndex: 1, selected: false, cells: [cell("time", "TIME", "Oct 2", "2026-10-02T14:00:00.000Z"), cell("title", "HEADLINE", "Sanctions"), cell("categories", "CATEGORY", "Regulatory")] },
      ],
      truncated: false,
      truncationReasons: [],
      loadingStateDetected: false,
      errorStateDetected: false,
      errorStateMarkers: [],
      emptyStateDetected: false,
      emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = buildDomPaneReportFromRender(resolved, screenshot);
  const lines = report.text.split("\n");
  const header = lines.find((line) => line.includes("HEADLINE"))!;
  const row = lines.find((line) => line.includes("Sanctions"))!;
  expect(row.indexOf("Regulatory")).toBe(header.indexOf("CATEGORY"));
  expect(lines.find((line) => line.includes("Deal"))).toContain("2026-10-07 11:27 UTC");
  expect(row).toContain("2026-10-02 14:00 UTC");
  // The pane's declaration says what the data is; a footer phrase does not turn it into a feed.
  expect(report.data.freshness).toMatchObject({ source: "Gloom Cloud", asOf: "2026-10-07T11:27:00.000Z", status: "not-a-feed" });
  // --csv writes the same columns, the blank cell empty and each time as the instant behind it.
  expect(renderReportCsv(report.tables).split("\n")).toEqual([
    "TIME,HEADLINE,TICKERS,CATEGORY",
    "2026-10-07T11:27:00.000Z,Deal,PSKY,M&A",
    "2026-10-02T14:00:00.000Z,Sanctions,,Regulatory",
    "",
    "# Source: Gloom Cloud · Wed 7 Oct 2026 11:27 UTC · not a live feed (published stories)",
  ]);
});

/**
 * An OMON capture of a 10-strike window centred on the money: the viewport
 * shows three rows, the table publishes all five it lists, and the pane says
 * how many of the expiry's strikes those are.
 */
function omonCapture() {
  const row = (strike: number, rowIndex: number) => ({
    tableIndex: 0, rowIndex, key: String(strike), selected: strike === 720,
    cells: [{ columnId: "callDelta", columnLabel: "C Δ", text: ".600" }, { columnId: "strike", columnLabel: "STRIKE", text: String(strike) }],
  });
  const notice = "5 of 145 strikes, 2 either side of the money (700 to 740). --strikes all lists every strike.";
  return {
    resolved: {
      token: "OMON", label: "Options", options: { strikes: "2" },
      pane: { id: "options" }, capability: { id: "options-pane", screenshotReadiness: "live-dom" },
    } as unknown as ResolvedPaneFunction,
    notice,
    render: {
      visibleText: "OMON META Strikes ±2 710 720 730",
      rows: [710, 720, 730].map(row),
      reportRows: [700, 710, 720, 730, 740].map(row),
      truncated: true,
      truncationReasons: ["rows above and below the rendered viewport are cut"],
      reportTruncationReasons: [],
      loadingStateDetected: false, errorStateDetected: false, errorStateMarkers: [],
      emptyStateDetected: false, emptyStateMarkers: [], visibleKeyValues: [],
      semanticUi: [{
        id: "ui:1", role: "report-notice", actions: [],
        metadata: { text: notice, key: "strikes", value: { window: "2", shown: 5, total: 145 } },
      }],
    },
  };
}

test("an OMON report reads every strike of its window past the viewport, and says how many of the expiry's it lists", () => {
  const { resolved, render, notice } = omonCapture();
  const report = buildDomPaneReportFromRender(resolved, { symbols: ["META"], render } as unknown as PaneScreenshotResult);
  expect(report.data).toMatchObject({
    rowCount: 5, complete: true, truncated: false, truncationReasons: [],
    metadata: { strikes: { window: "2", shown: 5, total: 145 }, notices: [notice] },
  });
  expect((report.data.rows as Array<{ key: string }>).map((row) => row.key)).toEqual(["700", "710", "720", "730", "740"]);
  expect(report.text).toContain(notice);

  // A table read from the viewport alone stays incomplete, and says which side was cut.
  const viewportOnly = { ...render, reportRows: undefined, reportTruncationReasons: undefined };
  const clipped = buildDomPaneReportFromRender(resolved, { symbols: ["META"], render: viewportOnly } as unknown as PaneScreenshotResult);
  expect(clipped.data).toMatchObject({ rowCount: 3, complete: false, truncationReasons: ["rows above and below the rendered viewport are cut"] });
});

test("an OMON shot names the rows its image cuts and how many strikes the window lists", () => {
  const { resolved, render, notice } = omonCapture();
  const shot = assessPaneScreenshot(resolved, { financials: [["META", {}]] } as unknown as DesktopPaneShotPayload,
    render as DesktopPaneShotRenderResult, "META", "/tmp/omon-shot-test.png");
  expect(shot.notices).toEqual([notice]);
  expect(shot.rowCount).toBe(3);
  expect(shot.render.truncationReasons).toEqual(["rows above and below the rendered viewport are cut"]);
});

test("states the expiry a rendered OMON shows and dates the report by the chain behind it", () => {
  const resolved = {
    token: "OMON", label: "Options", options: { expiration: "2028-01-21" }, capability: { id: "options-pane" }, pane: { id: "options" },
  } as unknown as ResolvedPaneFunction;
  const screenshot = {
    symbols: ["AAPL"],
    render: {
      visibleText: "",
      // The capture keeps only warnings in the footer, so it never says delayed here.
      footerText: "",
      rows: [{ tableIndex: 0, rowIndex: 0, selected: false, cells: [{ columnLabel: "STRIKE", text: "340" }] }],
      semanticUi: [
        { id: "ui:1", role: "report-notice", actions: [], metadata: {
          text: "Expiry 2028-01-21 (469d)", key: "expiry", value: { date: "2028-01-21", daysToExpiry: 469 },
        } },
        { id: "ui:2", role: "report-freshness", actions: [], metadata: {
          asOf: "2026-10-09T19:59:59.999Z", status: "delayed", delayMinutes: 15,
        } },
      ],
      truncated: false,
      truncationReasons: [],
      loadingStateDetected: false,
      errorStateDetected: false,
      errorStateMarkers: [],
      emptyStateDetected: false,
      emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = buildDomPaneReportFromRender(resolved, screenshot);
  expect(report.text.split("\n").slice(0, 3)).toEqual(["Options", "", "Expiry 2028-01-21 (469d)"]);
  expect(report.data.metadata).toMatchObject({ expiry: { date: "2028-01-21", daysToExpiry: 469 } });
  expect(formatFreshnessLine(report.data.freshness)).toBe("Source: Gloom Cloud · Fri 9 Oct 2026 19:59 UTC · 15 min delayed");
  expect(renderReportCsv(report.tables)).toContain("# note: Expiry 2028-01-21 (469d)");
});

test("dates a rendered FXC by the observations behind its rates, in the report and in its JSON", () => {
  const resolved = {
    token: "FXC", label: "FX Cross Rates", options: {}, capability: { id: "fx-matrix-pane" }, pane: { id: "fx-matrix" },
  } as unknown as ResolvedPaneFunction;
  // Saturday 12:00 UTC (the clock above): Friday's close for the euro, a quiet tick on Saturday morning for the rand.
  const observation = (currency: string, quoteTime: string) => ({
    currency, quoteTime, dataSource: "delayed", stale: false, sessionExchange: "CCY", marketState: "CLOSED",
  });
  const screenshot = {
    symbols: [],
    render: {
      visibleText: "",
      // The pane's own footer states its rates' ages, not their feed.
      footerText: "oldest rate 2026-10-09 21:29 UTC · fetched 5m ago",
      rows: [{ tableIndex: 0, rowIndex: 0, selected: false, cells: [{ columnLabel: "EUR", text: "1.1206" }] }],
      semanticUi: [{
        id: "ui:1", role: "report-freshness", actions: [], metadata: {
          observations: [observation("EUR", "2026-10-09T21:29:00.000Z"), observation("ZAR", "2026-10-10T04:21:11.000Z")],
        },
      }],
      truncated: false, truncationReasons: [], loadingStateDetected: false, errorStateDetected: false, errorStateMarkers: [],
      emptyStateDetected: false, emptyStateMarkers: [],
    },
  } as unknown as PaneScreenshotResult;

  const report = buildDomPaneReportFromRender(resolved, screenshot);
  expect(formatFreshnessLine(report.data.freshness)).toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed");
  expect(report.data.freshness).toMatchObject({ status: "delayed", asOf: "2026-10-10T04:21:11.000Z", asOfClose: "2026-10-09", market: { state: "closed" } });
  expect(renderReportCsv(report.tables)).toContain("# Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · delayed · markets closed");

  // A pane that publishes nothing is still not reported.
  const bare = { ...screenshot, render: { ...screenshot.render, semanticUi: [] } } as unknown as PaneScreenshotResult;
  expect(formatFreshnessLine(buildDomPaneReportFromRender(resolved, bare).data.freshness)).toContain("status not reported");
});
