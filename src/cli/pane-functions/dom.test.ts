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
