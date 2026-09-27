import type { BoxRenderable } from "@opentui/core";
import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { Box, Text } from "../../ui";
import { PaneStatusBody } from "./status";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
});

test("content replacing the loading body sits at the pane origin without the status padding", async () => {
  let setLoading: (loading: boolean) => void = () => {};
  let content: BoxRenderable | null = null;
  function Harness() {
    const [loading, setLoadingState] = useState(true);
    setLoading = setLoadingState;
    return (
      <Box flexDirection="column" width={24} height={6}>
        <PaneStatusBody loading={loading} subject="prices">
          <Box ref={(node: BoxRenderable | null) => { content = node; }} flexGrow={1}>
            <Text>CONTENT</Text>
          </Box>
        </PaneStatusBody>
      </Box>
    );
  }

  setup = await testRender(<Harness />, { width: 24, height: 6 });
  await act(async () => { await setup!.renderOnce(); });
  expect(setup.captureCharFrame()).toContain("Loading prices...");

  await act(async () => { setLoading(false); });
  await act(async () => {
    await setup!.renderOnce();
    await setup!.renderOnce();
  });

  const box = content as BoxRenderable | null;
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(24);
  expect(box?.height).toBe(6);
  expect(setup.captureCharFrame().split("\n")[0]?.startsWith("CONTENT")).toBe(true);
});
