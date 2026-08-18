import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { TestDialogProvider, testRender } from "../../../renderers/opentui/test-utils";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
} from "../../../state/app/context";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { Box, Text } from "../../../ui";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { createNotesTab } from "./ticker-notes-tab";
import type { NotesFiles } from "./files";

const TEST_PANE_ID = "ticker-detail:notes-test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeTicker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

function createMockNotesFiles(options?: {
  loadDelayMs?: number;
  notes?: Record<string, string>;
  saveError?: Error;
}) {
  const saves: Array<{ symbol: string; text: string }> = [];
  const notes = new Map(Object.entries(options?.notes ?? {}));
  const loadDelayMs = options?.loadDelayMs ?? 0;
  return {
    saves,
    async load(symbol: string) {
      if (loadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, loadDelayMs));
      }
      return notes.get(symbol) ?? "";
    },
    async save(symbol: string, text: string) {
      saves.push({ symbol, text });
      if (options?.saveError) throw options.saveError;
    },
    async delete() {},
    quickNoteKey(id: string) {
      return `__quick__/${id}`;
    },
    async loadQuickNotesIndex() {
      return [];
    },
    async saveQuickNotesIndex() {},
  } as unknown as NotesFiles & { saves: Array<{ symbol: string; text: string }> };
}

function createNotesHarnessConfig(symbol: string) {
  const config = createDefaultConfig("/tmp/gloomberb-notes-tab");
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "ticker-detail",
      binding: { kind: "fixed" as const, symbol },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...config,
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
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
        <AppContext value={{ state, dispatch }}>
          <PaneInstanceProvider paneId={TEST_PANE_ID}>
            <PluginRenderProvider pluginId="notes" runtime={runtime}>
              <PaneFooterProvider>
                {() => (
                  <>
                    <NotesTab
                      width={78}
                      height={20}
                      focused={focused}
                      onCapture={() => {}}
                    />
                    <Text onMouseDown={() => setFocused(false)}>blur-tab</Text>
                    <Text onMouseDown={() => switchSymbol("MSFT")}>switch-msft</Text>
                  </>
                )}
              </PaneFooterProvider>
            </PluginRenderProvider>
          </PaneInstanceProvider>
        </AppContext>
      </Box>
    </TestDialogProvider>
  );
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
});

describe("createNotesTab", () => {
  test("surfaces a save failure when the tab loses focus", async () => {
    const notifications: string[] = [];
    const notesFiles = createMockNotesFiles({ saveError: new Error("disk full") });
    const NotesTab = createNotesTab(notesFiles);
    const runtime = createTestPluginRuntime({
      notify: ({ body }) => { notifications.push(body); },
    });

    testSetup = await testRender(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" runtime={runtime} />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;
    expect(placeholderRow).toBeGreaterThanOrEqual(0);
    expect(placeholderCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(placeholderCol + 1, placeholderRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.mockInput.typeText("ab");
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("ab");

    const blurRow = frame.split("\n").findIndex((line) => line.includes("blur-tab"));
    const blurCol = frame.split("\n")[blurRow]?.indexOf("blur-tab") ?? -1;
    expect(blurRow).toBeGreaterThanOrEqual(0);

    const originalError = console.error;
    console.error = () => {};
    try {
      await act(async () => {
        await testSetup!.mockMouse.click(blurCol + 1, blurRow);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await testSetup!.renderOnce();
      });
    } finally {
      console.error = originalError;
    }

    expect(notesFiles.saves).toEqual([{ symbol: "AAPL", text: "ab" }]);
    expect(notifications).toEqual(["Failed to save note. Check disk space and permissions."]);
  });

  test("does not save stale buffer text to a new ticker before its notes load", async () => {
    const notesFiles = createMockNotesFiles({
      loadDelayMs: 50,
      notes: { MSFT: "msft-note" },
    });
    const NotesTab = createNotesTab(notesFiles);

    testSetup = await testRender(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(placeholderCol + 1, placeholderRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.mockInput.typeText("aapl-note");
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("aapl-note");

    const switchRow = frame.split("\n").findIndex((line) => line.includes("switch-msft"));
    const switchCol = frame.split("\n")[switchRow]?.indexOf("switch-msft") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(switchCol + 1, switchRow);
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    const blurRow = frame.split("\n").findIndex((line) => line.includes("blur-tab"));
    const blurCol = frame.split("\n")[blurRow]?.indexOf("blur-tab") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(blurCol + 1, blurRow);
      await testSetup!.renderOnce();
    });

    expect(notesFiles.saves).toEqual([{ symbol: "AAPL", text: "aapl-note" }]);
  });

  test("does not overwrite notes when switching away before initial load completes", async () => {
    const notesFiles = createMockNotesFiles({
      loadDelayMs: 100,
      notes: { AAPL: "existing-aapl-note", MSFT: "" },
    });
    const NotesTab = createNotesTab(notesFiles);

    testSetup = await testRender(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    const switchRow = frame.split("\n").findIndex((line) => line.includes("switch-msft"));
    const switchCol = frame.split("\n")[switchRow]?.indexOf("switch-msft") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(switchCol + 1, switchRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await testSetup!.renderOnce();
    });

    expect(notesFiles.saves).toEqual([]);
  });

  test("loads new ticker notes after switching away from edit mode", async () => {
    const notesFiles = createMockNotesFiles({
      loadDelayMs: 100,
      notes: { MSFT: "msft-note" },
    });
    const NotesTab = createNotesTab(notesFiles);

    testSetup = await testRender(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(placeholderCol + 1, placeholderRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.mockInput.typeText("aapl-note");
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    const switchRow = frame.split("\n").findIndex((line) => line.includes("switch-msft"));
    const switchCol = frame.split("\n")[switchRow]?.indexOf("switch-msft") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(switchCol + 1, switchRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    const previewRow = frame.split("\n").findIndex((line) => line.includes("Write notes") || line.includes("msft-note"));
    const previewCol = frame.split("\n")[previewRow]?.search(/Write notes|msft-note/) ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(previewCol + 1, previewRow);
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("msft-note");
    expect(notesFiles.saves).toEqual([{ symbol: "AAPL", text: "aapl-note" }]);
  });

  test("applies loaded notes if edit mode starts before load finishes", async () => {
    const notesFiles = createMockNotesFiles({
      loadDelayMs: 100,
      notes: { AAPL: "existing-note" },
    });
    const NotesTab = createNotesTab(notesFiles);

    testSetup = await testRender(
      <NotesTabHarness NotesTab={NotesTab} initialSymbol="AAPL" />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    let frame = testSetup.captureCharFrame();
    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(placeholderCol + 1, placeholderRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("existing-note");
  });
});
