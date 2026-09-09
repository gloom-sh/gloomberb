import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { Box, Text } from "../../ui";
import { KeyValueRow } from "./display";
import { EmptyState } from "./status";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
});

test("metric rows use available width and narrow status messages keep their final line", async () => {
  setup = await testRender(
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
    await setup!.renderOnce();
    await setup!.renderOnce();
  });
  const lines = setup.captureCharFrame().split("\n");
  expect(lines[0]).toContain("100,000 -> 200,000");
  expect(lines[1]?.indexOf("| next")).toBe(5);
  expect(lines.map((line) => line.trim()).join(" ")).toContain("retry shortly.");
});
