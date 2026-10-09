import { expect, test } from "bun:test";
import type { ResolvedPaneFunction } from "./resolver";
import type { PaneScreenshotResult } from "./screenshot";
import { buildDomPaneReportFromRender } from "./dom";

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
});
