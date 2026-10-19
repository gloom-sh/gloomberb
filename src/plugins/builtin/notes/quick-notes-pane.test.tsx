import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { act, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, TestDialogProvider } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, Text } from "../../../ui";
import { NotesFiles } from "./files";
import { createQuickNotesPane } from "./quick-notes-pane";
import { createTestNotesFiles, registryFor, type TestNotesFiles } from "./test-fixture";

const tui = createOpenTuiTestHarness();

const TAB_A = "tab-a";
const TAB_B = "tab-b";

/** Two quick notes, the first empty. */
function createMockNotesFiles(options: { loadDelayMs?: number } = {}) {
  return createTestNotesFiles({
    ...options,
    notes: { [TAB_A]: "", [TAB_B]: "beta-note" },
    index: [{ id: TAB_A, title: "Alpha" }, { id: TAB_B, title: "Beta" }],
  });
}

const PANE_INSTANCE_ID = "quick-notes:test";
const paneRuntime = createTestPluginRuntime();

function QuickNotesHarness({
  QuickNotesPane,
}: {
  QuickNotesPane: ReturnType<typeof createQuickNotesPane>;
}) {
  const [focused, setFocused] = useState(true);
  // The open note is pane state, so the harness needs a reducer.
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = createInitialState(createTestPaneConfig("/tmp/quick-notes-test", {
    paneId: "quick-notes", instanceId: PANE_INSTANCE_ID,
  }));
  state.paneState = paneState;
  const dispatch = (action: AppAction) => setPaneState(
    (current) => appReducer({ ...state, paneState: current }, action).paneState,
  );

  return (
    <TestDialogProvider>
      <TestPaneProvider
        state={state}
        dispatch={dispatch}
        paneId={PANE_INSTANCE_ID}
        pluginId="notes"
        runtime={paneRuntime}
      >
        <Box flexDirection="column" width={80} height={24}>
          <PaneFooterProvider>
            {() => (
              <>
                <QuickNotesPane paneId={PANE_INSTANCE_ID} paneType="quick-notes" focused={focused} width={78} height={20} />
                <Text onMouseDown={() => setFocused(false)}>blur-pane</Text>
              </>
            )}
          </PaneFooterProvider>
        </Box>
      </TestPaneProvider>
    </TestDialogProvider>
  );
}

describe("createQuickNotesPane", () => {
  test("does not save stale buffer text to a new tab before its notes load", async () => {
    const notesFiles = createMockNotesFiles({ loadDelayMs: 50 });
    const QuickNotesPane = createQuickNotesPane(registryFor(notesFiles));

    await tui.render(
      <QuickNotesHarness QuickNotesPane={QuickNotesPane} />,
      { width: 80, height: 24 },
    );
    await tui.setup().renderOnce();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
    let frame = tui.frame();
    expect(frame).toContain("Alpha");

    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(placeholderCol + 1, placeholderRow);
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("alpha-note");
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).toContain("alpha-note");

    const betaRow = frame.split("\n").findIndex((line) => line.includes("Beta"));
    const betaCol = frame.split("\n")[betaRow]?.indexOf("Beta") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(betaCol + 1, betaRow);
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    const blurRow = frame.split("\n").findIndex((line) => line.includes("blur-pane"));
    const blurCol = frame.split("\n")[blurRow]?.indexOf("blur-pane") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(blurCol + 1, blurRow);
      await tui.setup().renderOnce();
    });

    expect(notesFiles.saves).toEqual([{ key: TAB_A, text: "alpha-note" }]);
  });

  test("never presents an unreadable note as an empty editable one", async () => {
    const notesFiles = createMockNotesFiles();
    const failing = {
      ...notesFiles,
      async load() {
        throw new Error("EACCES: permission denied");
      },
    } as unknown as TestNotesFiles;
    const QuickNotesPane = createQuickNotesPane(registryFor(failing));

    await tui.render(
      <QuickNotesHarness QuickNotesPane={QuickNotesPane} />,
      { width: 80, height: 24 },
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await tui.setup().renderOnce();
      });
      if (tui.frame().includes("could not be read")) break;
    }

    const frame = tui.frame();
    expect(frame).toContain("could not be read");
    expect(frame).not.toContain("Write notes");

    // Clicking the body must not open an editor over content we failed to read.
    const errorRow = frame.split("\n").findIndex((line) => line.includes("could not be read"));
    await act(async () => {
      await tui.setup().mockMouse.click(2, errorRow);
      await tui.setup().mockInput.typeText("clobber");
      await tui.setup().renderOnce();
    });

    const blurRow = tui.frame().split("\n").findIndex((line) => line.includes("blur-pane"));
    await act(async () => {
      await tui.setup().mockMouse.click(2, blurRow);
      await tui.setup().renderOnce();
    });

    expect(notesFiles.saves).toEqual([]);
  });
  test("an index it cannot read is never saved over, and a first run still gets its first tab", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gloomberb-quick-notes-"));
    const index = join(dir, "__quick-notes-index__.json");
    const settle = async (text: string) => {
      for (let attempt = 0; attempt < 10 && !tui.frame().includes(text); attempt++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await tui.setup().renderOnce();
        });
      }
    };
    try {
      writeFileSync(index, "[{\"id\":\"q1\",\"title\":\"Ideas\"");
      const QuickNotesPane = createQuickNotesPane(registryFor(new NotesFiles(dir)));
      await tui.render(<QuickNotesHarness QuickNotesPane={QuickNotesPane} />, { width: 80, height: 24 });
      await settle("could not be read");
      expect(tui.frame()).toContain("Quick notes could not be read.");
      // Adding a note does not write a fresh index over the old one either.
      await act(async () => {
        await tui.setup().mockMouse.click(tui.frame().split("\n")[0]!.indexOf("+"), 0);
        await tui.setup().renderOnce();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tui.setup().renderOnce();
      });
      expect(tui.frame()).toContain("Quick notes could not be read.");
      expect(readFileSync(index, "utf-8")).toBe("[{\"id\":\"q1\",\"title\":\"Ideas\"");

      // No index at all is a first run: the first tab is made and saved.
      rmSync(index);
      const FirstRunPane = createQuickNotesPane(registryFor(new NotesFiles(dir)));
      await tui.render(<QuickNotesHarness QuickNotesPane={FirstRunPane} />, { width: 80, height: 24 });
      await settle("New");
      for (let attempt = 0; attempt < 10 && !existsSync(index); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(JSON.parse(readFileSync(index, "utf-8"))).toEqual([{ id: expect.any(String), title: "New" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
