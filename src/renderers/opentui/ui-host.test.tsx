import type { BoxRenderable } from "@opentui/core";
import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { Box, Text } from "../../ui";
import { testRender } from "./test-utils";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
});

test("a reused box drops layout props that are no longer passed", async () => {
  let setSized: (sized: boolean) => void = () => {};
  let inner: BoxRenderable | null = null;
  function Harness() {
    const [sized, setSizedState] = useState(true);
    setSized = setSizedState;
    // Same type at the same position, so React updates one box in place.
    return (
      <Box flexDirection="column" width={20} height={6}>
        {sized ? (
          <Box
            ref={(node: BoxRenderable | null) => { inner = node; }}
            width={8}
            height={3}
            paddingX={1}
            paddingY={1}
            marginLeft={2}
            marginTop={1}
            top={1}
            left={1}
            maxHeight={4}
            maxWidth={9}
          >
            <Text>X</Text>
          </Box>
        ) : (
          <Box ref={(node: BoxRenderable | null) => { inner = node; }} flexGrow={1}>
            <Text>Y</Text>
          </Box>
        )}
      </Box>
    );
  }

  setup = await testRender(<Harness />, { width: 24, height: 8 });
  await act(async () => { await setup!.renderOnce(); });
  const sizedBox = inner as BoxRenderable | null;
  expect(sizedBox?.x).toBeGreaterThan(0);

  await act(async () => { setSized(false); });
  await act(async () => {
    await setup!.renderOnce();
    await setup!.renderOnce();
  });

  const box = inner as BoxRenderable | null;
  expect(box).toBe(sizedBox);
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  expect(box?.width).toBe(20);
  expect(box?.height).toBe(6);
  expect(setup.captureCharFrame().split("\n")[0]?.startsWith("Y")).toBe(true);
});

test("a box that loses its numeric width shrinks again", async () => {
  let setSized: (sized: boolean) => void = () => {};
  let inner: BoxRenderable | null = null;
  function Harness() {
    const [sized, setSizedState] = useState(true);
    setSized = setSizedState;
    return (
      <Box flexDirection="row" width={10} height={1}>
        {sized ? (
          <Box ref={(node: BoxRenderable | null) => { inner = node; }} width={4}><Text>A</Text></Box>
        ) : (
          <Box ref={(node: BoxRenderable | null) => { inner = node; }} flexBasis={16}><Text>A</Text></Box>
        )}
      </Box>
    );
  }

  setup = await testRender(<Harness />, { width: 12, height: 2 });
  await act(async () => { await setup!.renderOnce(); });
  expect((inner as BoxRenderable | null)?.width).toBe(4);

  await act(async () => { setSized(false); });
  await act(async () => {
    await setup!.renderOnce();
    await setup!.renderOnce();
  });
  // A 16-cell basis in a 10-cell row only fits when flexShrink is back to 1.
  expect((inner as BoxRenderable | null)?.width).toBe(10);
});

test("a dropped padding edge falls back to the broader padding still passed", async () => {
  let setEdge: (edge: boolean) => void = () => {};
  let inner: BoxRenderable | null = null;
  function Harness() {
    const [edge, setEdgeState] = useState(true);
    setEdge = setEdgeState;
    return (
      <Box flexDirection="column" width={12} height={3}>
        <Box ref={(node: BoxRenderable | null) => { inner = node; }} paddingX={1} paddingLeft={edge ? 4 : undefined}>
          <Text>Z</Text>
        </Box>
      </Box>
    );
  }

  setup = await testRender(<Harness />, { width: 12, height: 3 });
  await act(async () => { await setup!.renderOnce(); });
  expect(setup.captureCharFrame().split("\n")[0]?.indexOf("Z")).toBe(4);

  await act(async () => { setEdge(false); });
  await act(async () => {
    await setup!.renderOnce();
    await setup!.renderOnce();
  });
  expect(setup.captureCharFrame().split("\n")[0]?.indexOf("Z")).toBe(1);
  expect((inner as BoxRenderable | null)?.x).toBe(0);
});
