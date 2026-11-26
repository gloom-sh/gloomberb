import { expect, test } from "bun:test";
import { fitDataTableColumns } from "../../../components/ui/data-table/column-fit";
import type { IvScreenRow } from "./client";
import { projectRichCheap } from "./model";
import { VCA_COLUMN_DROP_ORDER, VCA_COLUMNS, vcaColumns } from "./screen-pane";

/** A ranked close with its 25-delta risk reversal, as the screen's service sends a symbol. */
function screened(symbol: string, date: string, skewDate: string): IvScreenRow {
  return {
    symbol, status: "ready", iv90: null,
    iv30: { value: 0.1574, date, method: "trade-close", basis: "print", spot: 752.69, rank: 20, percentile: 15, low: 0.12, high: 0.3, samples: 250, windowStart: "2025-11-07" },
    rr25: { value: -0.051, put25: 0.188, call25: 0.137, date: skewDate, method: "trade-close", rank: 30, percentile: 12, low: -0.09, high: -0.02, samples: 250,
      windowStart: "2025-11-07", minSamples: 20, fullYear: true },
    latest: { date, method: "trade-close", basis: "print", capturedAt: "", spot: 752.69, iv7: null, iv30: 0.1574, iv60: null, iv90: 0.17, iv180: null, iv365: null },
    skew: { date: skewDate, put25: 0.188, call25: 0.137, skew: 0.051 },
  };
}
const ids = (shown: readonly { id: string }[]) => shown.map((column) => column.id).join(" ");

test("a screen sorted by RR pctl keeps the percentile beside the skew's own date, not the IV's, at every desktop width", () => {
  // Two IV sessions, and one risk reversal from an earlier session than its row's IV: the pane draws both dates.
  const rows = projectRichCheap([screened("SPY", "2026-11-09", "2026-11-06"), screened("QQQ", "2026-11-06", "2026-11-06")]);
  const columns = vcaColumns(rows);
  expect(ids(columns)).toBe("symbol iv30 date spot rank percentile verdict termSlope riskReversal riskReversalPercentile skewDate hv ivHv");
  const drawn = (cells: number, sortColumnId: string) => fitDataTableColumns(columns, cells, { anchoredColumns: 1, sortColumnId, dropOrder: VCA_COLUMN_DROP_ORDER });

  // The percentile kept alone stood beside the IV's "As of", a session it was not measured on.
  expect(ids(drawn(55, "riskReversalPercentile"))).toBe("symbol riskReversal riskReversalPercentile skewDate");
  expect(ids(drawn(86, "riskReversalPercentile"))).toBe("symbol iv30 date rank percentile riskReversal riskReversalPercentile skewDate");
  // Too narrow for the reversal, its percentile and their date beside the symbol: every column, scrolling sideways.
  expect(drawn(40, "riskReversalPercentile")).toBe(columns);

  for (let cells = 20; cells <= 160; cells += 1) {
    for (const sort of ["riskReversalPercentile", "riskReversal", "percentile", "hv"]) {
      const shown = new Set(drawn(cells, sort).map((column) => column.id));
      expect(shown.has(sort)).toBe(true);
      // Neither figure without the date they share, and no date without a figure.
      expect(`${cells} ${sort} ${shown.has("riskReversalPercentile")} ${shown.has("riskReversal")}`).toBe(`${cells} ${sort} ${shown.has("skewDate")} ${shown.has("skewDate")}`);
    }
  }

  // Where every date agrees the pane draws no skew date, and the percentile still leaves before the reversal does.
  const agreed = vcaColumns(projectRichCheap([screened("SPY", "2026-11-09", "2026-11-09"), screened("QQQ", "2026-11-06", "2026-11-06")]));
  expect(ids(agreed)).toBe("symbol iv30 date spot rank percentile verdict termSlope riskReversal riskReversalPercentile hv ivHv");
  expect(ids(fitDataTableColumns(agreed, 95, { anchoredColumns: 1, sortColumnId: "percentile", dropOrder: VCA_COLUMN_DROP_ORDER })))
    .toBe("symbol iv30 date rank percentile verdict termSlope riskReversal hv ivHv");
});

test("a screen sorted by HV20 keeps the figure beside the date it was observed on, at every desktop width", () => {
  // Realized volatility observed on another day than the IV: the pane draws HV's own date beside it.
  const columns = VCA_COLUMNS.filter((column) => column.id !== "skewDate");
  const drawn = (cells: number, sortColumnId: string) => fitDataTableColumns(columns, cells, { anchoredColumns: 1, sortColumnId, dropOrder: VCA_COLUMN_DROP_ORDER });

  // The sorted column kept alone left a figure dated by the IV's "As of", a day it was not observed on.
  expect(ids(drawn(60, "hv"))).toBe("symbol iv30 date hv hvDate ivHv");
  expect(ids(drawn(40, "hv"))).toBe("symbol hv hvDate ivHv");
  // Too narrow for those three beside the symbol: every column, in a table that scrolls sideways.
  expect(drawn(30, "hv")).toBe(columns);

  for (let cells = 20; cells <= 160; cells += 1) {
    for (const sort of ["hv", "percentile"]) {
      const shown = new Set(drawn(cells, sort).map((column) => column.id));
      expect(shown.has("symbol")).toBe(true);
      expect(shown.has(sort)).toBe(true);
      expect(`${cells} ${sort} ${shown.has("hvDate")}`).toBe(`${cells} ${sort} ${shown.has("hv")}`);
    }
  }
});
