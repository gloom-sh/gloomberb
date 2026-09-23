import { expect, test } from "bun:test";
import type { ResolvedPaneFunction } from "./resolver";
import type { PaneScreenshotResult } from "./screenshot";
import { buildDomPaneReportFromRender } from "./dom";

test("marks rendered reports as truncated when a visible cell contains an ellipsis", () => {
  const resolved = {
    token: "INS",
    label: "Insider",
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

test("keeps a cell under its own column when an earlier cell in the row is blank", () => {
  const resolved = { token: "TOP", label: "Top News", capability: { id: "news-top-pane" }, options: {} } as unknown as ResolvedPaneFunction;
  const cell = (columnId: string, columnLabel: string, text: string) => ({ columnId, columnLabel, text });
  const screenshot = {
    symbols: [],
    render: {
      visibleText: "",
      rows: [
        { tableIndex: 0, rowIndex: 0, selected: false, cells: [cell("title", "HEADLINE", "Deal"), cell("tickers", "TICKERS", "PSKY"), cell("categories", "CATEGORY", "M&A")] },
        // The DOM capture drops the blank TICKERS cell.
        { tableIndex: 0, rowIndex: 1, selected: false, cells: [cell("title", "HEADLINE", "Sanctions"), cell("categories", "CATEGORY", "Regulatory")] },
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

  const lines = buildDomPaneReportFromRender(resolved, screenshot).text.split("\n");
  const header = lines.find((line) => line.includes("HEADLINE"))!;
  const row = lines.find((line) => line.includes("Sanctions"))!;
  expect(row.indexOf("Regulatory")).toBe(header.indexOf("CATEGORY"));
});
