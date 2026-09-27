import { describe, expect, test } from "bun:test";
import { statGridRows, type StatItem } from "../ui/stat-grid";
import { CHART_MIN_ROWS, chartTableLayout } from "./layout";

const FIGURES: StatItem[] = [
  { id: "level", label: "5Y spread", value: "235bp", detail: "2026-09-25" },
  { id: "change", label: "1M", value: "+13bp" },
  { id: "range", label: "Range", value: "34 to 235bp", detail: "since 2025-02-24" },
];
const CHART = { minRows: CHART_MIN_ROWS };
// At 90 columns the three figures pack into two StatGrid rows.
const FIGURE_ROWS_90 = statGridRows(FIGURES, 90);

describe("chartTableLayout", () => {
  test("gives the chart 40% of a long table's pane", () => {
    const layout = chartTableLayout({ width: 90, height: 26, figures: FIGURES, tableRows: 250, chart: CHART });
    expect(FIGURE_ROWS_90).toBe(2);
    expect(layout).toMatchObject({ mode: "full", figureRows: 2, chartRows: Math.round(24 * 0.4) });
  });

  test("lets the chart take what a short table does not need", () => {
    // A six-row board keeps exactly its header and six rows.
    const layout = chartTableLayout({ width: 90, height: 40, figures: FIGURES, tableRows: 6, chart: CHART });
    expect(layout.chartRows).toBe(40 - FIGURE_ROWS_90 - 7);
  });

  test("keeps the table's header and four rows before the chart gives way", () => {
    // 12 rows: one figure row (the second row of figures gives way to the
    // chart), six chart rows, then the header and four table rows.
    const layout = chartTableLayout({ width: 90, height: 12, figures: FIGURES, tableRows: 250, chart: CHART });
    expect(layout).toMatchObject({ mode: "full", figureRows: 1, chartRows: 6 });
    expect(layout.figures.length).toBeLessThan(FIGURES.length);
  });

  test("drops to a one-row strip, then to nothing, as the pane shrinks", () => {
    expect(chartTableLayout({ width: 90, height: 10, figures: FIGURES, tableRows: 250, chart: CHART }))
      .toMatchObject({ mode: "strip", chartRows: 1 });
    expect(chartTableLayout({ width: 90, height: 6, figures: FIGURES, tableRows: 250, chart: CHART }))
      .toMatchObject({ mode: "none", chartRows: 0 });
    expect(chartTableLayout({ width: 20, height: 40, figures: FIGURES, tableRows: 250, chart: CHART }).mode).toBe("none");
  });

  test("trims figures from the end instead of letting them wrap in a short pane", () => {
    const narrow = chartTableLayout({ width: 40, height: 10, figures: FIGURES, tableRows: 250, chart: CHART });
    expect(narrow.figureRows).toBe(1);
    expect(narrow.figures.map((item) => item.id)).toEqual(["level"]);
    const tall = chartTableLayout({ width: 40, height: 40, figures: FIGURES, tableRows: 250, chart: CHART });
    expect(tall.figures).toHaveLength(3);
  });

  test("gives a table with no room for a row the body back", () => {
    const layout = chartTableLayout({ width: 90, height: 2, figures: FIGURES, tableRows: 10, chart: CHART });
    expect(layout).toMatchObject({ figureRows: 0, mode: "none" });
  });

  test("counts the query bar and the table's chrome rows", () => {
    const plain = chartTableLayout({ width: 90, height: 30, tableRows: 250, chart: CHART });
    const withBar = chartTableLayout({ width: 90, height: 30, queryRows: 1, tableRows: 250, tableChromeRows: 2, chart: CHART });
    expect(plain.chartRows).toBe(12);
    expect(withBar.chartRows).toBe(12);
    expect(chartTableLayout({ width: 90, height: 11, queryRows: 1, tableRows: 250, tableChromeRows: 2, chart: CHART }).mode)
      .toBe("strip");
  });

  test("respects a custom chart's own minimum and a disabled strip", () => {
    const curve = { minRows: 9, strip: false };
    expect(chartTableLayout({ width: 90, height: 13, tableRows: 6, chart: curve }).mode).toBe("none");
    expect(chartTableLayout({ width: 90, height: 16, tableRows: 6, chart: curve })).toMatchObject({ mode: "full", chartRows: 9 });
  });

  test("with no chart the table and figures share the pane", () => {
    expect(chartTableLayout({ width: 90, height: 30, figures: FIGURES, tableRows: 40, chart: null }))
      .toMatchObject({ mode: "none", chartRows: 0, figureRows: FIGURE_ROWS_90 });
  });

  test("never gives a full band fewer rows than the chart can draw in", () => {
    // Six table rows leave seven spare rows: more than the 40% share, fewer than a nine-row curve needs.
    const layout = chartTableLayout({ width: 90, height: 14, tableRows: 6, chart: { minRows: 9 } });
    expect(layout).toMatchObject({ mode: "full", chartRows: 9 });
  });

  test("gives a short table's spare rows back to dropped figures when the chart is a strip", () => {
    const many: StatItem[] = [...FIGURES, { id: "a", label: "Alpha", value: "1.0" }, { id: "b", label: "Beta", value: "2.0" }];
    const layout = chartTableLayout({ width: 40, height: 9, figures: many, tableRows: 3, chart: CHART });
    expect(layout.mode).toBe("strip");
    expect(layout.figureRows).toBe(4);
    expect(layout.figureRows + layout.chartRows + 1 + 3).toBe(9);
  });
});
