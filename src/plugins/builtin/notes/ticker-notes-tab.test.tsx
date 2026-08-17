import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { TestDialogProvider, testRender } from "../../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  createInitialState,
} from "../../../state/app/context";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { Box, Text } from "../../../ui";
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

function createMockNotesFiles() {
  const saves: Array<{ symbol: string; text: string }> = [];
  return {
    saves,
    async load() {
      return "";
    },
    async save(symbol: string, text: string) {
      saves.push({ symbol, text });
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

function NotesTabHarness({
  NotesTab,
  symbol,
}: {
  NotesTab: ReturnType<typeof createNotesTab>;
  symbol: string;
}) {
  const [focused, setFocused] = useState(true);
  const config = createNotesHarnessConfig(symbol);
  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([[symbol, makeTicker(symbol)]]);

  return (
    <TestDialogProvider>
      <Box flexDirection="column" width={80} height={24}>
        <AppContext value={{ state, dispatch: () => {} }}>
          <PaneInstanceProvider paneId={TEST_PANE_ID}>
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
                </>
              )}
            </PaneFooterProvider>
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
  test("exits edit mode and saves when the tab loses focus", async () => {
    const notesFiles = createMockNotesFiles();
    const NotesTab = createNotesTab(notesFiles);

    testSetup = await testRender(
      <NotesTabHarness NotesTab={NotesTab} symbol="AAPL" />,
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

    await act(async () => {
      await testSetup!.mockMouse.click(blurCol + 1, blurRow);
      await testSetup!.renderOnce();
    });

    expect(notesFiles.saves).toEqual([{ symbol: "AAPL", text: "ab" }]);
  });
});
