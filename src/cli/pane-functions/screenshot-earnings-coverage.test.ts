import { expect, test } from "bun:test";
import { earningsQuarters } from "../../plugins/builtin/research/event-charts";
import type { EventRow } from "../../plugins/builtin/research/event-model";
import type { DesktopPaneShotPayload, DesktopPaneShotRenderedRow } from "../desktop-pane-shot";
import { assessPaneScreenshot } from "./screenshot-assessment";
import type { ResolvedPaneFunction } from "./resolver";

test("only a reported actual with no evidence of consensus gets the no-consensus marker", () => {
  const reported = { status: "Earnings", earningsState: "reported", epsActual: 0, period: "Q3 FY2026", detail: "" } as const;
  const rows: EventRow[] = [
    { ...reported, id: "without-consensus", date: "2026-11-20" },
    { ...reported, id: "zero-consensus", date: "2026-10-20", epsEstimate: 0 },
    { ...reported, id: "with-difference", date: "2026-09-20", epsDifference: 0.4 },
    { ...reported, id: "with-surprise", date: "2026-08-20", surprisePercent: 1 },
    { ...reported, id: "actual-missing", date: "2026-07-20", epsActual: undefined },
    { ...reported, id: "pending", date: "2026-11-27", earningsState: "pending", epsActual: undefined },
    { ...reported, id: "overdue", date: "2026-11-24", earningsState: "pending", epsActual: undefined },
  ];
  const quarters = earningsQuarters(rows, "2026-11-26");
  expect(quarters.filter((row) => row.withoutConsensus).map((row) => row.id)).toEqual(["without-consensus"]);
  expect(quarters[0]).toMatchObject({ rowId: "pending", upcoming: true });
  expect(quarters[1]).toMatchObject({ eps: 0, detail: "no consensus" });
});

function quarter(key: string, estimate: string, surprise: string, withoutConsensus = false): DesktopPaneShotRenderedRow {
  const upcoming = key.startsWith("next:");
  return { key, tableIndex: 0, rowIndex: 0, selected: false, cells: [
    { columnId: "period", columnLabel: "QUARTER", text: "Q3 FY2026" },
    { columnId: "eps", columnLabel: "EPS", text: upcoming ? "" : "0.25", ...(upcoming ? { mayBeBlank: true } : {}) },
    { columnId: "estimate", columnLabel: "EST", text: estimate, ...(withoutConsensus ? { mayBeBlank: true } : {}) },
    { columnId: "surprise", columnLabel: "SURPRISE", text: surprise, ...(withoutConsensus || upcoming ? { mayBeBlank: true } : {}) },
  ] };
}

test("strict earnings captures allow reported quarters without consensus but catch a single lost required cell in a mixed table", () => {
  const uncovered = (suffix: string) => quarter(`earn:${suffix}`, "—", "—", true);
  const covered = quarter("earn:covered", "0.00", "N/M");
  const forthcoming = quarter("next:scheduled", "0.10", "");
  const noCoverage = [uncovered("first"), uncovered("second"), uncovered("third")];
  for (const [token, id, options] of [["EVT", "corporate-actions", {}], ["EE", "earnings-estimates", { view: "reported" }]] as const) {
    const resolved = { token, pane: { id }, instance: { paneId: id }, options,
      capability: { id, screenshotReadiness: "live-dom", options: [] } } as unknown as ResolvedPaneFunction;
    const assess = (rows: DesktopPaneShotRenderedRow[]) => assessPaneScreenshot(resolved, { financials: [] } as unknown as DesktopPaneShotPayload, {
      rows, visibleText: "", truncated: false, truncationReasons: [], loadingStateDetected: false, errorStateDetected: false,
      errorStateMarkers: [], emptyStateDetected: false, emptyStateMarkers: [], semanticUi: [],
    }, "", "quarter-coverage.png");
    expect(assess(noCoverage)).toMatchObject({ usable: true, semanticMismatch: false });
    expect(assess([forthcoming, covered, ...noCoverage])).toMatchObject({ usable: true, semanticMismatch: false });
    const narrow = [covered, ...noCoverage].map((row) => ({ ...row, cells: row.cells.filter((cell) => cell.columnId !== "surprise") }));
    expect(assess(narrow)).toMatchObject({ usable: true, semanticMismatch: false });
    for (const [broken, missing] of [
      [quarter("earn:lost-estimate", "—", "+25.00%"), "EST"],
      [quarter("earn:lost-surprise", "0.20", "—"), "SURPRISE"],
      [quarter("next:pending", "—", ""), "EST"],
    ] as const) {
      expect(assess([covered, ...noCoverage, broken])).toMatchObject({
        usable: false, semanticMismatch: true, render: { chartEvidenceMismatches: [`${missing} missing for ${broken.key}`] },
      });
    }
  }
});
