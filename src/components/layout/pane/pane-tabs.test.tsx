import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, Text } from "../../../ui";
import { NestedPaneTabs } from "./header-tabs";
import { usePaneTabs } from "./pane-tabs";

const PANE_ID = "nested-tabs:test";
const tui = createOpenTuiTestHarness();
const runtime = createTestPluginRuntime();
let shown = { section: "", view: "" };

afterEach(() => {
  shown = { section: "", view: "" };
});

/** A view with its own nested switch, as Holders has Table and Chart under a research tab's choices. */
function View({ width }: { width: number }) {
  const [view, setView] = useState("table");
  shown.view = view;
  const { strip } = usePaneTabs({
    tabs: [{ value: "table", label: "Table" }, { value: "chart", label: "Chart" }],
    activeValue: view, onSelect: setView, focused: true, keyboardNavigation: false, queryBarWidth: width,
  });
  return <Box flexDirection="column">{strip}<Text>{`body:${view}`}</Text></Box>;
}

/**
 * A section's views under the pane's own strip. A research tab's view sits in
 * its own `NestedPaneTabs`; a Fixed Income view (an auction's Bills and Notes)
 * at the same level as the section's strip.
 */
function Section({ width, choices, viewNested }: { width: number; choices: string[]; viewNested: boolean }) {
  const [section, setSection] = useState(choices[0]!);
  shown.section = section;
  const { strip } = usePaneTabs({
    tabs: choices.map((value) => ({ value, label: value.toUpperCase() })),
    activeValue: section, onSelect: setSection, focused: true, keyboardNavigation: false, dense: true, queryBarWidth: width,
  });
  return <Box flexDirection="column">{strip}{viewNested ? <NestedPaneTabs><View width={width} /></NestedPaneTabs> : <View width={width} />}</Box>;
}

async function render(choices: string[], viewNested = true): Promise<void> {
  const config = createTestPaneConfig("/tmp/gloomberb-test", { instanceId: PANE_ID, paneId: "test-pane", binding: { kind: "none" } });
  const state = createInitialState(config);
  state.focusedPaneId = PANE_ID;
  await tui.render(
    <TestPaneFrame state={state} paneId={PANE_ID} pluginId="test" runtime={runtime} width={60} height={8} footerKeys>
      {({ width }) => <NestedPaneTabs><Section width={width} choices={choices} viewNested={viewNested} /></NestedPaneTabs>}
    </TestPaneFrame>,
    { width: 60, height: 8 },
  );
  await act(async () => { await tui.setup().renderOnce(); });
}

async function press(sequence: string): Promise<void> {
  await tui.emitKeypress({ name: sequence, sequence });
  await act(async () => { await tui.setup().renderOnce(); });
}

test.each([
  ["a level deeper", true],
  ["at the same level", false],
])("{ and } walk the outermost nested strip's choices, past either end, with a view's own switch %s", async (_, viewNested) => {
  await render(["a", "b", "c"], viewNested);
  expect(tui.frame()).toContain("[{}]view");

  await press("}");
  expect(shown).toEqual({ section: "b", view: "table" });
  await press("{");
  await press("{");
  // Past the first choice is the last.
  expect(shown).toEqual({ section: "c", view: "table" });
  await press("}");
  expect(shown.section).toBe("a");
  // The view's own switch under the section's choices keeps its state: the keys were never its.
  expect(shown.view).toBe("table");
});

test("with nothing to choose above it, the view's own switch has { and }", async () => {
  await render(["only"]);
  await press("}");
  expect(shown).toEqual({ section: "only", view: "chart" });
  // One hint, never one per strip.
  expect(tui.frame().split("[{}]view").length - 1).toBe(1);
});
