import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import { CommandBarHarness, createCommandBarTestControls } from "../surface/test-harness";

const tui = createOpenTuiTestHarness();
const { waitForFrameToContain } = createCommandBarTestControls(() => tui.setup());

test("the open bar covers only its sheet: the panes beside and below it stay drawn", async () => {
  const width = 100;
  // The app under the bar, a row of # in every cell between the header and the probes.
  const rows = Array.from({ length: 36 }, (_, row) => <Text key={row}>{"#".repeat(width)}</Text>);
  await tui.render(<CommandBarHarness query="" underlay={rows} />, { width, height: 40 });
  const lines = (await waitForFrameToContain("Start Here")).split("\n");
  const full = "#".repeat(width);
  // The sheet hangs from the header to the first row of the app it leaves whole.
  const below = lines.findIndex((line, index) => index > 0 && line === full);
  const sheetRows = lines.slice(1, below);
  expect(sheetRows.length).toBeGreaterThan(9);
  expect(sheetRows.some((line) => line.includes("Start Here"))).toBe(true);
  // Beside the sheet, on each of its rows, the panes keep what they drew, on both sides.
  for (const line of sheetRows) expect(line).toMatch(/^#[^#].*[^#]#{20,}$/);
  // Under it, the app's rows are as they were.
  expect(lines.slice(below, below + 8).every((line) => line === full)).toBe(true);
});
