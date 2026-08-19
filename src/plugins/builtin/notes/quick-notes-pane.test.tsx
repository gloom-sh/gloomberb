import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { TestDialogProvider, testRender } from "../../../renderers/opentui/test-utils";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, Text } from "../../../ui";
import { PluginRenderProvider } from "../../runtime";
import { createQuickNotesPane } from "./quick-notes-pane";
import type { NotesFiles } from "./files";
import type { QuickNoteEntry } from "./model";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

const TAB_A = "tab-a";
const TAB_B = "tab-b";

function createMockNotesFiles(options?: { loadDelayMs?: number }) {
  const saves: Array<{ key: string; text: string }> = [];
  const notes = new Map<string, string>([
    [TAB_A, ""],
    [TAB_B, "beta-note"],
  ]);
  const index: QuickNoteEntry[] = [
    { id: TAB_A, title: "Alpha" },
    { id: TAB_B, title: "Beta" },
  ];
  const loadDelayMs = options?.loadDelayMs ?? 0;

  return {
    saves,
    async load(key: string) {
      if (loadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, loadDelayMs));
      }
      return notes.get(key) ?? "";
    },
    async save(key: string, text: string) {
      saves.push({ key, text });
      notes.set(key, text);
    },
    async delete() {},
    quickNoteKey(id: string) {
      return id;
    },
    async loadQuickNotesIndex() {
      return index;
    },
    async saveQuickNotesIndex() {},
  } as unknown as NotesFiles & { saves: Array<{ key: string; text: string }> };
}

function QuickNotesHarness({
  QuickNotesPane,
}: {
  QuickNotesPane: ReturnType<typeof createQuickNotesPane>;
}) {
  const [focused, setFocused] = useState(true);

  return (
    <TestDialogProvider>
      <PluginRenderProvider pluginId="notes" runtime={createTestPluginRuntime()}>
        <Box flexDirection="column" width={80} height={24}>
          <PaneFooterProvider>
            {() => (
              <>
                <QuickNotesPane focused={focused} width={78} height={20} />
                <Text onMouseDown={() => setFocused(false)}>blur-pane</Text>
              </>
            )}
          </PaneFooterProvider>
        </Box>
      </PluginRenderProvider>
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

describe("createQuickNotesPane", () => {
  test("does not save stale buffer text to a new tab before its notes load", async () => {
    const notesFiles = createMockNotesFiles({ loadDelayMs: 50 });
    const QuickNotesPane = createQuickNotesPane(notesFiles);

    testSetup = await testRender(
      <QuickNotesHarness QuickNotesPane={QuickNotesPane} />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Alpha");

    const placeholderRow = frame.split("\n").findIndex((line) => line.includes("Write notes"));
    const placeholderCol = frame.split("\n")[placeholderRow]?.indexOf("Write notes") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(placeholderCol + 1, placeholderRow);
      await testSetup!.renderOnce();
    });

    await act(async () => {
      await testSetup!.mockInput.typeText("alpha-note");
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("alpha-note");

    const betaRow = frame.split("\n").findIndex((line) => line.includes("Beta"));
    const betaCol = frame.split("\n")[betaRow]?.indexOf("Beta") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(betaCol + 1, betaRow);
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    const blurRow = frame.split("\n").findIndex((line) => line.includes("blur-pane"));
    const blurCol = frame.split("\n")[blurRow]?.indexOf("blur-pane") ?? -1;

    await act(async () => {
      await testSetup!.mockMouse.click(blurCol + 1, blurRow);
      await testSetup!.renderOnce();
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
    } as unknown as NotesFiles & { saves: Array<{ key: string; text: string }> };
    const QuickNotesPane = createQuickNotesPane(failing);

    testSetup = await testRender(
      <QuickNotesHarness QuickNotesPane={QuickNotesPane} />,
      { width: 80, height: 24 },
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await testSetup!.renderOnce();
      });
      if (testSetup.captureCharFrame().includes("could not be read")) break;
    }

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("could not be read");
    expect(frame).not.toContain("Write notes");

    // Clicking the body must not open an editor over content we failed to read.
    const errorRow = frame.split("\n").findIndex((line) => line.includes("could not be read"));
    await act(async () => {
      await testSetup!.mockMouse.click(2, errorRow);
      await testSetup!.mockInput.typeText("clobber");
      await testSetup!.renderOnce();
    });

    const blurRow = testSetup.captureCharFrame().split("\n").findIndex((line) => line.includes("blur-pane"));
    await act(async () => {
      await testSetup!.mockMouse.click(2, blurRow);
      await testSetup!.renderOnce();
    });

    expect(notesFiles.saves).toEqual([]);
  });
});
