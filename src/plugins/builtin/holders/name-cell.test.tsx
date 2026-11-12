import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { Box, Text } from "../../../ui";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { holderNameCell } from "./pane";

const tui = createOpenTuiTestHarness();

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

// The table fits the holder column to the width the cell says it takes: a cell that says less is cut.
test("a holder's name and its markers draw whole in the width the cell says, and a cell narrower cuts the name first", async () => {
  const name = "Pentwater Capital Management LP";
  for (const markers of [{ receipts: "ADR", fund: false }, { receipts: "", fund: true }, { receipts: "ADR", fund: true }]) {
    const whole = holderNameCell(name, markers, "#ffffff", 0).contentWidth!;
    const cell = holderNameCell(name, markers, "#ffffff", whole);
    const drawn = await drawnIn(whole, cell.content);
    expect(drawn).toHaveLength(whole);
    expect(drawn).toStartWith(name);
    expect(drawn.trimEnd()).toEndWith(markers.fund ? "13F" : "ADR");

    const narrow = await drawnIn(whole - 4, holderNameCell(name, markers, "#ffffff", whole - 4).content);
    expect(narrow).not.toContain(name);
    expect(narrow.trimEnd()).toEndWith(markers.fund ? "13F" : "ADR");
  }
});
