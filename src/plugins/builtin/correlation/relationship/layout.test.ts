import { expect, test } from "bun:test";
import { relationshipLayout } from "./pane";

test("a short pane drops the scatter before a price panel, and hidden pieces hand their rows to the chart", () => {
  // Tall: every panel plus the scatter.
  expect(relationshipLayout(40, { showCorrelation: true, showScatter: true }))
    .toEqual({ chartRows: 28, scatterRows: 12, ratio: true, correlation: true });
  // Short: the scatter goes first and the chart takes all the rows.
  expect(relationshipLayout(17, { showCorrelation: true, showScatter: true }))
    .toEqual({ chartRows: 17, scatterRows: 0, ratio: true, correlation: true });
  // Fit off: no scatter, whatever the height.
  expect(relationshipLayout(40, { showCorrelation: true, showScatter: false }).chartRows).toBe(40);
  // Very short: correlation, then the ratio, give way to price.
  expect(relationshipLayout(9, { showCorrelation: true, showScatter: true }))
    .toEqual({ chartRows: 9, scatterRows: 0, ratio: true, correlation: false });
  expect(relationshipLayout(6, { showCorrelation: true, showScatter: true }).ratio).toBe(false);
});
