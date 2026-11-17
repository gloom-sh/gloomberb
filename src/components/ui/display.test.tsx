import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { Box, Text } from "../../ui";
import { ClippedText, KeyValueRow } from "./display";
import { EmptyState } from "./status";

const tui = createOpenTuiTestHarness();

test("metric rows use available width and narrow status messages keep their final line", async () => {
  await tui.render(
    <Box flexDirection="column" width={30}>
      <KeyValueRow width={30} labelWidth={8} label="Margin" value="100,000 -> 200,000" />
      <Box flexDirection="row">
        <KeyValueRow width={5} labelWidth={16} label="Long label" value="42" />
        <Text>| next</Text>
      </Box>
      <Box width={22}>
        <EmptyState status="error" title="Provider unavailable." message="The provider could not complete the request; please retry shortly." />
      </Box>
    </Box>,
    { width: 40, height: 12 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  const lines = tui.frame().split("\n");
  expect(lines[0]).toContain("100,000 -> 200,000");
  expect(lines[1]?.indexOf("| next")).toBe(5);
  expect(lines.map((line) => line.trim()).join(" ")).toContain("retry shortly.");
});

test("a clipped name keeps its end whole in the terminal: \"Cus… 1\", never \"Custo…\"", async () => {
  await tui.render(<Box flexDirection="column" width={20}>
    <ClippedText text="Customer 1" width={6} keepEnd=" 1" />
    <ClippedText text="Customer A" width={6} />
    <ClippedText text="Customer 2" width={12} keepEnd=" 2" />
  </Box>, { width: 20, height: 3 });
  await act(async () => { await tui.setup().renderOnce(); });
  expect(tui.frame().split("\n").map((line) => line.trimEnd()).slice(0, 3)).toEqual(["Cus… 1", "Custo…", "Customer 2"]);
});
