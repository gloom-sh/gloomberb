import { describe, expect, test } from "bun:test";
import { act } from "react";
import { TestShellPaneKeys } from "../../../test-support/shell-pane-keys";
import {
  createChatTestHarness,
  createController,
  createHarness,
  makeMessage,
} from "./test-harness";

const tui = createChatTestHarness();
const { emitKeypress, flushFrame } = tui;
const ESC = { name: "escape", sequence: "\u001b" };

async function mountChatPane(options: Parameters<typeof createController>[0] = {}) {
  const controller = createController({ messages: [makeMessage(1), makeMessage(2)], ...options });
  const closes = { count: 0 };
  await act(async () => {
    await tui.render(
      <>
        {createHarness(controller, { width: 72, height: 12 })}
        <TestShellPaneKeys
          focusedPaneId="chat:main"
          closeFocusedPane={() => {
            closes.count += 1;
            return true;
          }}
        />
      </>,
      { width: 72, height: 12 },
    );
  });
  await flushFrame();
  return closes;
}

async function focusComposer(draft = "") {
  await emitKeypress({ name: "i", sequence: "i" });
  await flushFrame();
  if (!draft) return;
  await act(async () => {
    await tui.setup().mockInput.typeText(draft);
    await tui.setup().renderOnce();
  });
  await flushFrame();
}

describe("double Esc in the chat", () => {
  test("closes an idle chat, after the Esc that clears a selection", async () => {
    const closes = await mountChatPane();

    await emitKeypress(ESC);
    await emitKeypress(ESC);
    expect(closes.count).toBe(1);

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    const clearSelection = await emitKeypress(ESC);
    expect(clearSelection.propagationStopped).toBe(true);
    await emitKeypress(ESC);
    expect(closes.count).toBe(1);
    await emitKeypress(ESC);
    expect(closes.count).toBe(2);
  });

  test("counts leaving an empty composer, never leaving a draft or a reply", async () => {
    const closes = await mountChatPane({ replyToId: "m2" });

    // The first Esc drops the reply target, the second leaves the now empty composer.
    await focusComposer();
    expect(tui.frame()).toContain("replying to @user2");
    await emitKeypress(ESC);
    await flushFrame();
    expect(tui.frame()).not.toContain("replying to @user2");
    await emitKeypress(ESC);
    expect(closes.count).toBe(0);
    await emitKeypress(ESC);
    expect(closes.count).toBe(1);

    await focusComposer("draft");
    const leaveDraft = await emitKeypress(ESC);
    expect(leaveDraft.propagationStopped).toBe(true);
    await emitKeypress(ESC);
    expect(closes.count).toBe(1);
    expect(tui.frame()).toContain("> draft");
  });
});
