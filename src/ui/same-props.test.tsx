import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { act, memo, useState, type ReactNode } from "react";
import { Box, Text } from ".";
import { ColumnGridPair } from "../components/ui/column-grid";
import { PaneLinkMenu } from "../components/ui/external-link";
import { PaneFooterProvider } from "../components/layout/pane/footer";
import { setLanguage } from "../i18n";
import { es } from "../i18n/es";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { getThemeColors, syncTheme } from "../theme/colors";
import { ThemeProvider } from "../theme/theme-context";
import { DEFAULT_THEME } from "../theme/themes";
import type { ContextMenuItem } from "../types/context-menu";
import { markPure, samePureProps } from "./same-props";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setLanguage("en");
  syncTheme(DEFAULT_THEME);
});

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

test("a number and the string of it differ, as do lists of other lengths, and past six levels any new element counts as changed", () => {
  const same = (left: object, right: object) => samePureProps(left, right);
  expect(same({ children: 1 }, { children: "1" })).toBe(false);
  expect(same({ children: <Text>{1}</Text> }, { children: <Text>{"1"}</Text> })).toBe(false);
  expect(same({ children: [<Text key="a">a</Text>] }, { children: [<Text key="a">a</Text>, <Text key="b">b</Text>] })).toBe(false);
  // A trailing hole draws nothing, but the list still changed shape.
  expect(same({ children: ["a", null] }, { children: ["a"] })).toBe(false);

  const nest = (levels: number): ReactNode => levels === 1 ? <Text>x</Text> : <Box>{nest(levels - 1)}</Box>;
  expect(same({ children: nest(6) }, { children: nest(6) })).toBe(true);
  // Deeper than the comparison looks: equal, but drawn again rather than assumed the same.
  expect(same({ children: nest(7) }, { children: nest(7) })).toBe(false);
  const deep = nest(7);
  expect(same({ children: deep }, { children: deep })).toBe(true);
});

test("a new callback ref on a box or a text inside a box, other props unchanged, is attached and the old one let go", async () => {
  const calls: string[] = [];
  let setRound: (round: number) => void = () => {};
  function Parent() {
    const [round, setRoundState] = useState(1);
    setRound = setRoundState;
    // The outer box has no ref of its own: only its children's refs changed.
    return (
      <Box flexDirection="column" width={8} height={2}>
        <Box width={4} height={1} ref={(node: unknown) => { calls.push(`box ${round}:${node ? "node" : "null"}`); }} />
        <Text ref={(node: unknown) => { calls.push(`text ${round}:${node ? "node" : "null"}`); }}>x</Text>
      </Box>
    );
  }

  await tui.render(<Parent />, { width: 8, height: 2 });
  expect(calls.sort()).toEqual(["box 1:node", "text 1:node"]);
  calls.length = 0;
  await act(async () => { setRound(2); });
  expect(calls.sort()).toEqual(["box 1:null", "box 2:node", "text 1:null", "text 2:node"]);
});

test("a theme or a language change reaches a figure pair inside a box no parent re-renders", async () => {
  // No translation of the link's menu entry ships yet; one stands in for the test.
  const dictionary = es;
  dictionary["Open {label}"] = "Abrir {label}";
  try {
    let menu: ContextMenuItem[] = [];
    let setThemeId: (themeId: string) => void = () => {};
    // Rendered once: only the theme context and the language store reach the pair.
    const Figures = memo(function Figures() {
      return (
        <PaneLinkMenu>
          <Box flexDirection="row" width={24} height={1}>
            <ColumnGridPair label="Filing" labelWidth={8} width={24} value="10-K" url="https://sec.example/filing" />
          </Box>
        </PaneLinkMenu>
      );
    });
    function Root() {
      const [themeId, setThemeIdState] = useState(DEFAULT_THEME);
      setThemeId = setThemeIdState;
      return (
        <ThemeProvider themeId={themeId}>
          <PaneFooterProvider>{(footer) => { menu = footer.menu; return <Figures />; }}</PaneFooterProvider>
        </ThemeProvider>
      );
    }
    const labelColor = () => tui.setup().captureSpans().lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("Filing"))?.fg.toInts().join(",");
    const dim = (themeId: string) => RGBA.fromHex(getThemeColors(themeId).textDim).toInts().join(",");
    const menuLabels = () => menu.flatMap((item) => item.type === "divider" ? [] : [item.label]);

    await tui.render(<Root />, { width: 30, height: 2 });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(labelColor()).toBe(dim(DEFAULT_THEME));
    expect(menuLabels()).toEqual(["Open 10-K"]);

    const nextTheme = "amber";
    expect(dim(nextTheme)).not.toBe(dim(DEFAULT_THEME));
    await act(async () => { setThemeId(nextTheme); });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(labelColor()).toBe(dim(nextTheme));

    await act(async () => { setLanguage("es"); });
    expect(menuLabels()).toEqual(["Abrir 10-K"]);
  } finally {
    delete dictionary["Open {label}"];
  }
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
