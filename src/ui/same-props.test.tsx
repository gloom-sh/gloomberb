import { expect, test } from "bun:test";
import { act, memo, useState } from "react";
import { Box, Text } from ".";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { markPure, samePureProps } from "./same-props";

const tui = createOpenTuiTestHarness();

function Plain({ label }: { label: string }) {
  return <Text>{label}</Text>;
}
const Unmarked = memo(Plain);

test("elements of pure components compare by their props, any other element and function by identity", () => {
  const handler = () => {};
  const same = (left: object, right: object) => samePureProps(left, right);

  expect(same({ width: 4, children: <Text fg="red">x</Text> }, { width: 4, children: <Text fg="red">x</Text> })).toBe(true);
  expect(same(
    { children: [<Text key="a">a</Text>, <Box key="b"><Text>b</Text></Box>] },
    { children: [<Text key="a">a</Text>, <Box key="b"><Text>b</Text></Box>] },
  )).toBe(true);
  expect(same({ children: <Text>x</Text> }, { children: <Text>y</Text> })).toBe(false);
  expect(same({ children: <Text key="a">x</Text> }, { children: <Text key="b">x</Text> })).toBe(false);
  expect(same({ children: <Plain label="x" /> }, { children: <Plain label="x" /> })).toBe(false);
  expect(same({ children: <Unmarked label="x" /> }, { children: <Unmarked label="x" /> })).toBe(false);
  expect(same({ onMouseDown: handler }, { onMouseDown: handler })).toBe(true);
  expect(same({ onMouseDown: () => {} }, { onMouseDown: () => {} })).toBe(false);
  expect(same({ style: { flexGrow: 1 } }, { style: { flexGrow: 1 } })).toBe(false);
  expect(same({ width: 4 }, { width: 4, height: undefined })).toBe(false);
});

test("a parent render leaves a box of pure content alone, and still renders a component that reads more than its props", async () => {
  let rendersOfPure = 0;
  const Pure = markPure(memo(function Pure({ label }: { label: string }) {
    rendersOfPure += 1;
    return <Text>{label}</Text>;
  }));
  // Reads a value outside its props, as a component may: it is drawn afresh on each parent render.
  let outside = "first";
  function Outside() {
    return <Text>{outside}</Text>;
  }
  let setTick: (tick: number) => void = () => {};
  let setLabel: (label: string) => void = () => {};
  function Parent() {
    const [tick, setTickState] = useState(0);
    const [label, setLabelState] = useState("kept");
    setTick = setTickState;
    setLabel = setLabelState;
    return (
      <Box flexDirection="column" data-tick={tick}>
        <Box><Pure label={label} /></Box>
        <Box><Outside /></Box>
      </Box>
    );
  }

  await tui.render(<Parent />, { width: 12, height: 3 });
  await act(async () => { await tui.setup().renderOnce(); });
  expect(rendersOfPure).toBe(1);

  outside = "second";
  await act(async () => { setTick(1); });
  await act(async () => { await tui.setup().renderOnce(); });
  expect(rendersOfPure).toBe(1);
  expect(tui.frame().split("\n").slice(0, 2).map((line) => line.trim())).toEqual(["kept", "second"]);

  await act(async () => { setLabel("changed"); });
  await act(async () => { await tui.setup().renderOnce(); });
  expect(rendersOfPure).toBe(2);
  expect(tui.frame().split("\n")[0]?.trim()).toBe("changed");
});
