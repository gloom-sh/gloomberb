import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { ColumnGrid } from "./column-grid";

const tui = createOpenTuiTestHarness({ width: 40, height: 6 });

test("the terminal sets each column at the caller's cells: padded text, gaps, figures to the right, long text cut", async () => {
  await tui.render(
    <ColumnGrid
      width={32}
      columns={[
        { width: 12, growFrom: 8 },
        { width: 8, align: "right", gapBefore: 1 },
        { width: 10, align: "right", gapBefore: 1 },
      ]}
      rows={[
        [{ text: "Account" }, { text: "Qty" }, { text: "Value" }],
        [{ text: "A long account name" }, { text: "10 sh" }, { text: "1,052.50" }],
        [{ text: "Joint" }, { text: "1,234,567" }, { text: "123456789012" }],
      ]}
    />,
  );
  const rows = (await tui.waitForFrameToContain("Account")).split("\n").map((row) => row.trimEnd());
  expect(rows.slice(0, 3)).toEqual([
    "Account           Qty      Value",
    "A long accou    10 sh   1,052.50",
    "Joint        1,234,56 1234567890",
  ]);
});
