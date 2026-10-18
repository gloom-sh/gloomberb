import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { coneWindowDate } from "./chart-model";
import { VolatilityConeChart } from "./charts";
import type { RealizedVolEvidenceStatus } from "./evidence";

const tui = createOpenTuiTestHarness();
const rows = [10, 30, 260].map((window, index) => ({ window, min: 0.05 * (index + 1), max: 0.3 + 0.05 * index,
  mean: 0.2, current: 0.1 * (index + 1), median: 0.2, percentile: 50, sampleSize: 250 }));
const evidence: RealizedVolEvidenceStatus = { symbol: "AAPL", view: "cone", estimator: "close-to-close", windows: [10, 30], lookbackYears: 1,
  showIv: false, loading: false, stale: false, source: null, asOf: null, errors: [], currentIv: null };

async function legendAt(cursorDate: Date | null): Promise<string> {
  await tui.render(<VolatilityConeChart rows={rows} width={78} height={14} evidence={evidence}
    selection={{ cursorDate, onCursorDateChange: () => {}, onActivate: () => {} }} />, { width: 80, height: 16 });
  await act(async () => { await tui.setup().renderOnce(); await tui.setup().renderOnce(); });
  return tui.frame().split("\n")[0]!;
}

describe("volatility cone chart", () => {
  test("its legend reads the selected window, and the last one when none is selected", async () => {
    expect(await legendAt(coneWindowDate(30))).toMatch(/Min 10\.0%.*Max 35\.0%.*Mean 20\.0%.*Current 20\.0%/);
    expect(await legendAt(null)).toMatch(/Min 15\.0%.*Max 40\.0%.*Mean 20\.0%.*Current 30\.0%/);
  });
});
