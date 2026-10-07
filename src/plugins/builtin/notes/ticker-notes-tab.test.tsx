import { describe, expect, test } from "bun:test";
import { act, useReducer, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, TestDialogProvider } from "../../../renderers/opentui/test-utils";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { appReducer, createInitialState } from "../../../state/app/context";
import { Box, Text } from "../../../ui";
import type { PluginRuntimeAccess } from "../../runtime";
import { TestPaneProvider, createTestTicker as makeTicker, createTestPaneConfig } from "../../../test-support/pane";
import { createTestNotesFiles, registryFor } from "./test-fixture";
import { createNotesTab } from "./ticker-notes-tab";

const TEST_PANE_ID = "ticker-detail:notes-test";

const tui = createOpenTuiTestHarness();

function createNotesHarnessConfig(symbol: string) {
  return createTestPaneConfig("/tmp/gloomberb-notes-tab", {
    instanceId: TEST_PANE_ID,
    paneId: "ticker-detail",
    binding: { kind: "fixed", symbol },
  });
}

function NotesTabHarness({
  NotesTab,
  initialSymbol,
  runtime = createTestPluginRuntime(),
}: {
  NotesTab: ReturnType<typeof createNotesTab>;
  initialSymbol: string;
  runtime?: PluginRuntimeAccess;
}) {
  const [focused, setFocused] = useState(true);
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(createNotesHarnessConfig(initialSymbol));
    initial.focusedPaneId = TEST_PANE_ID;
    initial.tickers = new Map([
      ["AAPL", makeTicker("AAPL")],
      ["MSFT", makeTicker("MSFT")],
    ]);
    return initial;
  });

  const switchSymbol = (nextSymbol: string) => {
    dispatch({
      type: "UPDATE_LAYOUT",
      layout: {
        ...state.config.layout,
        instances: state.config.layout.instances.map((instance) => (
          instance.instanceId === TEST_PANE_ID
            ? { ...instance, binding: { kind: "fixed" as const, symbol: nextSymbol } }
            : instance
        )),
      },
    });
  };

  return (
    <TestDialogProvider>
      <Box flexDirection="column" width={80} height={24}>
        <TestPaneProvider state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="notes" runtime={runtime}>
          <PaneFooterProvider>
            {() => (
              <>
                <NotesTab
                  width={78}
                  height={20}
                  focused={focused}
                  onCapture={() => { }}
                />
                <Text onMouseDown={() => setFocused(false)}>blur-tab</Text>
                <Text onMouseDown={() => switchSymbol("MSFT")}>switch-msft</Text>
              </>
            )}
          </PaneFooterProvider>
        </TestPaneProvider>
      </Box>
    </TestDialogProvider>
  );
}

describe("createNotesTab", () => {
  test("surfaces a save failure when the tab loses focus", async () => {
    const notifications: string[] = [];
    const notesFiles = createTestNotesFiles({ saveError: new Error("disk full") });
    const NotesTab = createNotesTab(registryFor(notesFiles));
    const runtime = createTestPluginRuntime({
      notify: ({ body }) => { notifications.push(body); },
    });

    await tui.render(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" runtime={runtime} />,
      { width: 80, height: 24 },
    );
    await tui.setup().renderOnce();

    let frame = tui.frame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;
    expect(placeholderRow).toBeGreaterThanOrEqual(0);
    expect(placeholderCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(placeholderCol + 1, placeholderRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("ab");
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).toContain("ab");

    const blurRow = frame.split("\n").findIndex((line) => line.includes("blur-tab"));
    const blurCol = frame.split("\n")[blurRow]?.indexOf("blur-tab") ?? -1;
    expect(blurRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(blurCol + 1, blurRow);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });

    expect(notesFiles.saves).toEqual([{ key: "AAPL", text: "ab" }]);
    expect(notifications).toEqual(["disk full"]);
  });

  test("does not save stale buffer text to a new ticker before its notes load", async () => {
    const notesFiles = createTestNotesFiles({
      loadDelayMs: 50,
      notes: { MSFT: "msft-note" },
    });
    const NotesTab = createNotesTab(registryFor(notesFiles));

    await tui.render(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await tui.setup().renderOnce();

    let frame = tui.frame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(placeholderCol + 1, placeholderRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("aapl-note");
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).toContain("aapl-note");

    const switchRow = frame.split("\n").findIndex((line) => line.includes("switch-msft"));
    const switchCol = frame.split("\n")[switchRow]?.indexOf("switch-msft") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(switchCol + 1, switchRow);
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    const blurRow = frame.split("\n").findIndex((line) => line.includes("blur-tab"));
    const blurCol = frame.split("\n")[blurRow]?.indexOf("blur-tab") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(blurCol + 1, blurRow);
      await tui.setup().renderOnce();
    });

    expect(notesFiles.saves).toEqual([{ key: "AAPL", text: "aapl-note" }]);
  });

  test("does not overwrite notes when switching away before initial load completes", async () => {
    const notesFiles = createTestNotesFiles({
      loadDelayMs: 100,
      notes: { AAPL: "existing-aapl-note", MSFT: "" },
    });
    const NotesTab = createNotesTab(registryFor(notesFiles));

    await tui.render(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await tui.setup().renderOnce();

    let frame = tui.frame();
    const switchRow = frame.split("\n").findIndex((line) => line.includes("switch-msft"));
    const switchCol = frame.split("\n")[switchRow]?.indexOf("switch-msft") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(switchCol + 1, switchRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });

    expect(notesFiles.saves).toEqual([]);
  });

  test("loads new ticker notes after switching away from edit mode", async () => {
    const notesFiles = createTestNotesFiles({
      loadDelayMs: 100,
      notes: { MSFT: "msft-note" },
    });
    const NotesTab = createNotesTab(registryFor(notesFiles));

    await tui.render(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await tui.setup().renderOnce();

    let frame = tui.frame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(placeholderCol + 1, placeholderRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("aapl-note");
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    const switchRow = frame.split("\n").findIndex((line) => line.includes("switch-msft"));
    const switchCol = frame.split("\n")[switchRow]?.indexOf("switch-msft") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(switchCol + 1, switchRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    const previewRow = frame.split("\n").findIndex((line) => line.includes("Write notes") || line.includes("msft-note"));
    const previewCol = frame.split("\n")[previewRow]?.search(/Write notes|msft-note/) ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(previewCol + 1, previewRow);
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).toContain("msft-note");
    expect(notesFiles.saves).toEqual([{ key: "AAPL", text: "aapl-note" }]);
  });

  test("applies loaded notes if edit mode starts before load finishes", async () => {
    const notesFiles = createTestNotesFiles({
      loadDelayMs: 100,
      notes: { AAPL: "existing-note" },
    });
    const NotesTab = createNotesTab(registryFor(notesFiles));

    await tui.render(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await tui.setup().renderOnce();

    let frame = tui.frame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(placeholderCol + 1, placeholderRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).toContain("existing-note");
  });
});
