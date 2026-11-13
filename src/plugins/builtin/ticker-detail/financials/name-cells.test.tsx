import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { Box, Text, TextAttributes } from "../../../../ui";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import type { FinancialTableRow } from "./model";
import type { RatioTableRow } from "./ratios";
import { ratioNameCell } from "./ratio-table";
import { financialGroupNameCell } from "./tab";

const tui = createOpenTuiTestHarness();

/** The cell drawn in exactly the cells it says it takes, then a bar: what shows up to the bar. */
async function drawnIn(width: number, content: ReactNode): Promise<string> {
  await act(async () => {
    await tui.render(
      <Box flexDirection="row" width={60} height={1}>
        <Box width={width} height={1} overflow="hidden">{content}</Box>
        <Text>|</Text>
      </Box>,
      { width: 60, height: 1 },
    );
  });
  await act(async () => { await tui.setup().renderOnce(); });
  const line = tui.frame().split("\n")[0]!;
  return line.slice(0, line.indexOf("|"));
}

function group(depth: number, unitLabel: string, toggleable = true): Extract<FinancialTableRow, { kind: "group" }> {
  return {
    kind: "group", id: `group:${depth}`, label: unitLabel, unitLabel, moneyUnit: null, divisor: 1, format: "compact",
    growthDirection: "higher", depth, expanded: true, toggleable,
  };
}

// The table fits the metric column to the width a name cell says it takes: a cell that says less is cut.
test("a statement group's name draws whole in the width it says, at any depth, with or without a disclosure", async () => {
  for (const row of [group(0, "Revenue"), group(1, "Operating Exp (mn)"), group(2, "Working Capital", false)]) {
    const cell = financialGroupNameCell(row, "#ffffff", TextAttributes.NONE);
    const drawn = await drawnIn(cell.contentWidth!, cell.content);
    expect(drawn).toEndWith(row.unitLabel);
    expect(drawn).toHaveLength(cell.contentWidth!);
  }
});

test("a ratio's name draws whole in the width it says", async () => {
  const row = { kind: "ratio", id: "pe", label: "Price / Earnings", expanded: false } as Extract<RatioTableRow, { kind: "ratio" }>;
  const cell = ratioNameCell(row, "#ffffff");
  const drawn = await drawnIn(cell.contentWidth!, cell.content);
  expect(drawn).toBe("▸ Price / Earnings");
  expect(drawn).toHaveLength(cell.contentWidth!);
});
