import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { StaticScatterChartSurface } from "./scatter-chart-surface";

const tui = createOpenTuiTestHarness();

// Regression: both axis names sat at the left edge and neither axis showed a value.
test("shows values on both axes and names each at its own axis", async () => {
  const points = Array.from({ length: 40 }, (_, index) => ({ x: (index - 20) / 2, y: (index % 7) - 3 }));
  await tui.render(
    <StaticScatterChartSurface points={points} width={60} height={12} xLabel="AMD returns (%)" yLabel="NVDA returns (%)" />,
    { width: 62, height: 14 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  const rows = tui.frame().split("\n").filter((row) => row.trim());
  // y names itself above its values, at the right; x ends the row that holds its values.
  expect(rows[0]!.trimEnd()).toEndWith("NVDA returns (%) ↑");
  expect(rows.at(-1)!.trimEnd()).toEndWith("AMD returns (%) →");
  expect(rows.at(-1)).toMatch(/-?\d+\s+.*\d+\s+AMD returns/);
  expect(rows.slice(1, -1).some((row) => /\s-?\d+(\.\d+)?\s*$/.test(row))).toBe(true);
});
