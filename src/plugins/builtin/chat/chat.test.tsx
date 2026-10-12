import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { colors, hoverBg } from "../../../theme/colors";
import { createDefaultConfig } from "../../../types/config";
import type { ChatMessage } from "../../../api-client";
import { apiClient } from "../../../api-client";
import { PluginRenderProvider } from "../../runtime";
import { setSharedRegistryForTests } from "../../registry";
import { ChatContent } from "./content";
import { MESSAGE_HIGHLIGHT_MS } from "./content/row-activity";
import { SLOW_SEND_THRESHOLD_MS } from "./message/pending-send";
import { chatHighlightBg } from "./message/render-state";
import { chatBotNameColor } from "./people";
import { ChatStatusWidget } from "./status-widget";
import {
  createChatTestHarness,
  createController,
  createHarness,
  hexToRgbaInts,
  installServerChannels,
  lineText,
  makeMessage,
} from "./test-harness";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestFinancials } from "../../../test-support/data-provider";

const tui = createChatTestHarness();
const { flushFrame, emitKeypress, mountChat } = tui;

function recentChatTimestamp(offsetMs = 60_000) {
  return new Date(Date.now() - offsetMs).toISOString();
}

function makeOwnMessage(content = "typo", createdAt = recentChatTimestamp()): ChatMessage {
  return {
    id: "m-own",
    channelId: "everyone",
    content,
    replyToId: null,
    createdAt,
    user: { id: "u0", username: "ada", displayName: "Ada" },
  };
}

const makeNamedMessage = (index: number, username: string): ChatMessage => ({
  id: `named-${index}`,
  channelId: "everyone",
  content: `message from ${username}`,
  replyToId: null,
  createdAt: `2026-03-30T00:01:${String(index).padStart(2, "0")}.000Z`,
  user: { id: `u-${username}`, username, displayName: username },
});

async function renderFocusedComposerWithDraft(
  controller: ReturnType<typeof createController>,
  draft: string,
  options: Parameters<typeof createHarness>[1] = {},
) {
  await mountChat(controller, { width: 72, height: 14, ...options });

  const frameBeforeClick = tui.frame().split("\n");
  const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
  const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

  expect(inputRow).toBeGreaterThanOrEqual(0);
  expect(inputCol).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await tui.setup().mockMouse.click(inputCol + 1, inputRow);
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  await act(async () => {
    await tui.setup().mockInput.typeText(draft);
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  await flushFrame();
}

describe("ChatContent", () => {
  test("keeps a persisted DM selected while private channels refresh", async () => {
    const controller = createController();
    const dmChannelId = "dm:test";
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
    ]);
    controller.refreshChannels = async () => {};
    controller.refreshPresence = async () => {};
    controller.refreshSession = async () => {};
    controller.refreshChannelMessages = async () => {};
    const channelChanges: string[] = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
            <ChatContent
              controller={controller}
              width={60}
              height={12}
              focused
              channelId={dmChannelId}
              onChannelChange={(nextChannelId) => channelChanges.push(nextChannelId)}
            />
          </PluginRenderProvider>
        </AppContext>,
        { width: 60, height: 12 },
      );
    });

    await flushFrame();

    expect(channelChanges).toEqual([]);
  });

  test("focuses the prompt on click and preserves typing order", async () => {
    const controller = createController();

    await mountChat(controller);

    const frameBeforeClick = tui.frame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("DCF");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frameAfterType = tui.frame();
    expect(frameAfterType).toContain("> DCF");
    expect(frameAfterType).not.toContain("> FCD");
  });

  test("keeps appending typed text while transcript updates arrive", async () => {
    const controller = createController({
      messages: [makeMessage(1)],
    });

    await mountChat(controller);

    const frameBeforeClick = tui.frame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("alpha");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      (controller as any).mergeMessages([makeMessage(2)]);
    });

    await flushFrame();

    await act(async () => {
      await tui.setup().mockInput.typeText("beta");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frameAfterType = tui.frame();
    expect(frameAfterType).toContain("> alphabeta");
    expect(frameAfterType).not.toContain("> betaalpha");
  });

  test("autocompletes recent user mentions from the focused composer", async () => {
    const controller = createController({
      messages: [
        makeNamedMessage(1, "alpha"),
        makeNamedMessage(2, "bravo"),
        makeNamedMessage(3, "charlie"),
      ],
    });

    await renderFocusedComposerWithDraft(controller, "@");

    let frame = tui.frame();
    expect(frame).toContain("@charlie");
    expect(frame).toContain("@bravo");

    await emitKeypress({ name: "down", sequence: "\u001b[B" });

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    frame = tui.frame();
    expect(frame).toContain("> @bravo");
    expect(frame).not.toContain("@charlie");
  });

  test("tab accepts the current mention suggestion without pane cycling", async () => {
    const controller = createController({
      messages: [
        makeNamedMessage(1, "alpha"),
        makeNamedMessage(2, "bravo"),
        makeNamedMessage(3, "charlie"),
      ],
    });

    await renderFocusedComposerWithDraft(controller, "@");

    const event = await emitKeypress({ name: "tab", sequence: "\t" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("> @charlie");
    expect(frame).not.toContain("@bravo");
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  test("leaves tab for the command bar when mention suggestions are open behind it", async () => {
    const controller = createController({
      messages: [
        makeNamedMessage(1, "alpha"),
        makeNamedMessage(2, "bravo"),
        makeNamedMessage(3, "charlie"),
      ],
    });

    await renderFocusedComposerWithDraft(controller, "@", {
      configureState: (state) => {
        state.commandBarOpen = true;
      },
    });

    const event = await emitKeypress({ name: "tab", sequence: "\t" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("@charlie");
    expect(frame).toContain("> @");
    expect(frame).not.toContain("> @charlie");
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });

  test("up arrow selects the newest message first when nothing is selected", async () => {
    const controller = createController({
      messages: [makeMessage(1), makeMessage(2)],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await emitKeypress({ name: "return", sequence: "\r" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("replying to @user2");
    expect(frame).toContain("Reply to @user2...");
  });

  test("shows the reply action next to the selected message timestamp", async () => {
    const controller = createController({
      messages: [makeMessage(1), makeMessage(2)],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();

    const lines = tui.frame().split("\n");
    const headerLine = lines.find((line) => line.includes("user2"));
    const bodyLine = lines.find((line) => line.includes("message 2"));

    expect(headerLine).toContain("Reply");
    expect(bodyLine).not.toContain("Reply");
  });

  test("shows the edit action next to reply for the latest own message", async () => {
    const ownMessage = makeOwnMessage();
    const controller = createController({
      messages: [makeMessage(1), ownMessage],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();

    const lines = tui.frame().split("\n");
    const headerLine = lines.find((line) => line.includes("ada"));

    expect(headerLine).toContain("Reply");
    expect(headerLine).toContain("Edit");
  });

  test("hides the edit action after the edit window expires", async () => {
    const ownMessage = makeOwnMessage("typo", recentChatTimestamp(16 * 60_000));
    const controller = createController({
      messages: [makeMessage(1), ownMessage],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();

    const lines = tui.frame().split("\n");
    const headerLine = lines.find((line) => line.includes("ada"));

    expect(headerLine).toContain("Reply");
    expect(headerLine).not.toContain("Edit");
  });

  test("offers no edit for your latest message when it was written on Discord", async () => {
    const controller = createController({
      messages: [makeOwnMessage("from the app", recentChatTimestamp(120_000)), { ...makeOwnMessage("from the other side"), id: "m-own-dc", origin: "discord" }],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();

    const headerLine = tui.frame().split("\n").find((line) => line.includes("ada") && line.includes("Discord"));
    expect(headerLine).toContain("Reply");
    expect(headerLine).not.toContain("Edit");
  });

  test("up arrow from an empty focused composer edits the latest own message", async () => {
    const ownMessage = makeOwnMessage();
    const controller = createController({
      messages: [makeMessage(1), ownMessage],
    });

    await mountChat(controller, { width: 72, height: 12 });

    const lines = tui.frame().split("\n");
    const inputRow = lines.findIndex((line) => line.includes("Type a message..."));
    const inputCol = lines[inputRow]?.indexOf("Type a message...") ?? -1;
    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("editing");
    expect(frame).toContain("> typo");

    await act(async () => {
      await tui.setup().mockInput.typeText(" fix");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(tui.frame()).toContain("> typo fix");
  });

  test("down arrow from the newest selected message returns focus to the composer", async () => {
    const controller = createController({
      messages: [makeMessage(1), makeMessage(2)],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("Type a message...");
    expect(frame).not.toContain("Reply to @user2...");
    expect(frame).not.toContain("replying to @user2");
  });

  test("up arrow leaves the composer and selects the latest message when the caret is already at the top", async () => {
    const controller = createController({
      messages: [makeMessage(1)],
    });

    await mountChat(controller, { width: 72, height: 12 });

    const lines = tui.frame().split("\n");
    const inputRow = lines.findIndex((line) => line.includes("Type a message..."));
    const inputCol = lines[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      tui.setup().mockInput.pressArrow("up");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await emitKeypress({ name: "return", sequence: "\r" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("replying to @user1");
    expect(frame).toContain("Reply to @user1...");
  });

  test("up arrow targets the newest bottom message when multiple messages share a timestamp", async () => {
    const controller = createController({
      messages: [
        {
          id: "z-older",
          channelId: "everyone",
          content: "older same timestamp",
          replyToId: null,
          createdAt: "2026-03-30T00:00:01.000Z",
          user: { id: "u1", username: "older", displayName: "Older" },
        },
        {
          id: "a-newer",
          channelId: "everyone",
          content: "newer same timestamp",
          replyToId: null,
          createdAt: "2026-03-30T00:00:01.000Z",
          user: { id: "u2", username: "newer", displayName: "Newer" },
        },
      ],
    });

    await mountChat(controller, { width: 72, height: 12 });

    const lines = tui.frame().split("\n");
    const inputRow = lines.findIndex((line) => line.includes("Type a message..."));
    const inputCol = lines[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      tui.setup().mockInput.pressArrow("up");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await emitKeypress({ name: "return", sequence: "\r" });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("replying to @newer");
    expect(frame).toContain("Reply to @newer...");
  });

  test("shows a clear reply composer state when a reply target is active", async () => {
    const controller = createController({
      messages: [makeMessage(1)],
      replyToId: "m1",
    });

    await mountChat(controller, { width: 72, height: 12 });

    const frame = tui.frame();
    expect(frame).toContain("replying to @user1");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Reply to @user1...");
  });

  test("uses selected text colors for selected message rows", async () => {
    const controller = createController({
      messages: [makeMessage(1), makeMessage(2)],
    });

    await mountChat(controller, { width: 72, height: 12 });

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();

    const expectedSelectedFg = hexToRgbaInts(colors.selectedText);
    const frame = tui.setup().captureSpans();
    const headerLine = frame.lines.find((line) => lineText(line).includes("user2"));
    const bodyLine = frame.lines.find((line) => lineText(line).includes("message 2"));
    const headerSpan = headerLine?.spans.find((span) => span.text.includes("user2"));
    const bodySpan = bodyLine?.spans.find((span) => span.text.includes("message 2"));

    expect(headerSpan).toBeDefined();
    expect(bodySpan).toBeDefined();
    expect(headerSpan!.fg.toInts().join(",")).toBe(expectedSelectedFg);
    expect(bodySpan!.fg.toInts().join(",")).toBe(expectedSelectedFg);
  });

  describe("a message a chat deep link opened on", () => {
    const bodyBg = (text: string) => {
      const span = tui.setup().captureSpans().lines
        .filter((line) => lineText(line).includes(text))
        .flatMap((line) => line.spans)
        .find((candidate) => candidate.text.includes(text));
      return span?.bg.toInts().join(",");
    };
    const highlighted = hexToRgbaInts(chatHighlightBg());

    async function openOnFirstMessage() {
      const controller = createController({ messages: [makeMessage(1), makeMessage(2)] });
      let handled = 0;
      await mountChat(controller, {
        width: 72,
        height: 12,
        targetMessageId: "m1",
        onTargetMessageHandled: () => {
          handled += 1;
        },
      });
      expect(handled).toBe(1);
      return controller;
    }

    test("is marked, not selected: a selection would stay until someone cleared it", async () => {
      await openOnFirstMessage();

      expect(bodyBg("message 1")).toBe(highlighted);
      // The text keeps its usual colour: the selected look is the keyboard's cursor.
      const bodySpan = tui.setup().captureSpans().lines
        .filter((line) => lineText(line).includes("message 1"))
        .flatMap((line) => line.spans)
        .find((candidate) => candidate.text.includes("message 1"));
      expect(bodySpan!.fg.toInts().join(",")).not.toBe(hexToRgbaInts(colors.selectedText));
    });

    test("goes back to normal on a key press", async () => {
      await openOnFirstMessage();

      await emitKeypress({ name: "x", sequence: "x" });
      await flushFrame();

      expect(bodyBg("message 1")).not.toBe(highlighted);
    });

    test("goes back to normal on a wheel turn over the list", async () => {
      await openOnFirstMessage();

      await act(async () => {
        await tui.setup().mockMouse.scroll(20, 4, "up");
        await tui.setup().renderOnce();
      });
      await flushFrame();

      expect(bodyBg("message 1")).not.toBe(highlighted);
    });

    test("goes back to normal when a message arrives", async () => {
      const controller = await openOnFirstMessage();

      await act(async () => {
        (controller as any).mergeMessages([makeMessage(3)]);
      });
      await flushFrame();

      expect(bodyBg("message 1")).not.toBe(highlighted);
    });

    test("goes back to normal on its own", async () => {
      await openOnFirstMessage();
      expect(bodyBg("message 1")).toBe(highlighted);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, MESSAGE_HIGHLIGHT_MS + 100));
      });
      await flushFrame();

      expect(bodyBg("message 1")).not.toBe(highlighted);
    });

    // The pane clears a handled target, so a notification for the same message
    // clicked again names it anew: the open window has to jump a second time.
    test("is marked again when the same message is named a second time", async () => {
      const controller = createController({ messages: [makeMessage(1), makeMessage(2)] });
      const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
      let nameMessage: (messageId: string | undefined) => void = () => {};
      let handled = 0;
      function Pane() {
        const [target, setTarget] = useState<string | undefined>("m1");
        nameMessage = setTarget;
        return (
          <AppContext value={createStaticAppStore(state)}>
            <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
              <ChatContent
                controller={controller}
                width={72}
                height={12}
                focused
                targetMessageId={target}
                onTargetMessageHandled={() => {
                  handled += 1;
                  setTarget(undefined);
                }}
              />
            </PluginRenderProvider>
          </AppContext>
        );
      }
      await act(async () => {
        await tui.render(<Pane />, { width: 72, height: 12 });
      });
      await flushFrame();
      expect(handled).toBe(1);
      expect(bodyBg("message 1")).toBe(highlighted);

      await emitKeypress({ name: "x", sequence: "x" });
      await flushFrame();
      expect(bodyBg("message 1")).not.toBe(highlighted);

      await act(async () => {
        nameMessage("m1");
      });
      await flushFrame();
      expect(handled).toBe(2);
      expect(bodyBg("message 1")).toBe(highlighted);
    });

    test("leaves the list following new messages, which a selection would not", async () => {
      const controller = createController({ messages: [makeMessage(1), makeMessage(2), makeMessage(3), makeMessage(4), makeMessage(5), makeMessage(6)] });
      await mountChat(controller, { width: 60, height: 13, targetMessageId: "m6" });

      await act(async () => {
        (controller as any).mergeMessages([makeMessage(7)]);
      });
      await flushFrame();

      expect(tui.frame()).toContain("message 7");
    });
  });

  describe("the row under the pointer", () => {
    const bodyBg = (text: string) => {
      const span = tui.setup().captureSpans().lines
        .filter((line) => lineText(line).includes(text))
        .flatMap((line) => line.spans)
        .find((candidate) => candidate.text.includes(text));
      return span?.bg.toInts().join(",");
    };
    const hovered = hexToRgbaInts(hoverBg());

    async function hoverMessage(controller: ReturnType<typeof createController>, text: string) {
      await mountChat(controller, { width: 72, height: 12 });
      // The channel list draws once it has loaded, and moves the messages right.
      // A busy CI machine takes longer than the default 600 ms to load it.
      await tui.waitForFrameToContain("#everyone", 60);
      const rows = tui.frame().split("\n");
      const row = rows.findIndex((line) => line.includes(text));
      expect(row).toBeGreaterThanOrEqual(0);
      await act(async () => {
        await tui.setup().mockMouse.moveTo(rows[row]!.indexOf(text) + 1, row);
        await tui.setup().renderOnce();
      });
      await flushFrame();
      expect(bodyBg(text)).toBe(hovered);
    }

    test("is let go when a message arrives, which moves every row after it", async () => {
      const controller = createController({ messages: [makeMessage(1), makeMessage(2), makeMessage(3)] });
      await hoverMessage(controller, "message 2");

      await act(async () => {
        (controller as any).mergeMessages([makeMessage(4)]);
      });
      await flushFrame();

      expect(bodyBg("message 2")).not.toBe(hovered);
    });

    test("is let go when a key is pressed", async () => {
      const controller = createController({ messages: [makeMessage(1), makeMessage(2), makeMessage(3)] });
      await hoverMessage(controller, "message 2");

      await emitKeypress({ name: "x", sequence: "x" });
      await flushFrame();

      expect(bodyBg("message 2")).not.toBe(hovered);
    });
  });

  describe("new messages while the reader is scrolled back", () => {
    const manyMessages = () => Array.from({ length: 14 }, (_, index) => makeMessage(index + 1));

    async function scrollBack(controller: ReturnType<typeof createController>) {
      await mountChat(controller, { width: 60, height: 13 });
      await act(async () => {
        await tui.setup().mockMouse.scroll(20, 4, "up");
        await tui.setup().mockMouse.scroll(20, 4, "up");
        await tui.setup().renderOnce();
      });
      await flushFrame();
    }

    test("leave the view where it is and offer the newest message", async () => {
      const controller = createController({ messages: manyMessages() });
      await scrollBack(controller);
      const before = tui.frame();
      expect(before).not.toContain("1 new message");

      await act(async () => {
        (controller as any).mergeMessages([makeMessage(15)]);
      });
      await flushFrame();

      const frame = tui.frame();
      expect(frame).toContain("1 new message");
      expect(frame).not.toContain("message 15");
    });

    test("show the control, which takes the reader to the newest message when pressed", async () => {
      const controller = createController({ messages: manyMessages() });
      await scrollBack(controller);
      await act(async () => {
        (controller as any).mergeMessages([makeMessage(15), makeMessage(16)]);
      });
      await flushFrame();
      expect(tui.frame()).toContain("2 new messages");

      await tui.clickFrameText("2 new messages");
      await flushFrame();

      const frame = tui.frame();
      expect(frame).toContain("message 16");
      expect(frame).not.toContain("new messages");
    });

    test("do not count as new for a reader who is at the bottom", async () => {
      const controller = createController({ messages: manyMessages() });
      await mountChat(controller, { width: 60, height: 13 });

      await act(async () => {
        (controller as any).mergeMessages([makeMessage(15)]);
      });
      await flushFrame();

      const frame = tui.frame();
      expect(frame).toContain("message 15");
      expect(frame).not.toContain("new message");
    });
  });

  test("grows the composer for multi-line drafts", async () => {
    const controller = createController();

    await mountChat(controller, { width: 32, height: 12 });

    const frameBeforeClick = tui.frame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("alpha bravo");
      await tui.setup().renderOnce();
    });

    await emitKeypress({ name: "return", sequence: "\r", shift: true });

    await act(async () => {
      await tui.setup().mockInput.typeText("charlie delta");
      await tui.setup().renderOnce();
    });

    await emitKeypress({ name: "return", sequence: "\r", shift: true });

    await act(async () => {
      await tui.setup().mockInput.typeText("echo foxtrot");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const rows = tui.frame().split("\n");
    const firstRow = rows.findIndex((line) => line.includes("alpha bravo"));
    const secondRow = rows.findIndex((line) => line.includes("charlie delta"));
    const thirdRow = rows.findIndex((line) => line.includes("echo foxtrot"));

    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(secondRow).toBeGreaterThan(firstRow);
    expect(thirdRow).toBeGreaterThan(secondRow);
  });

  test("keeps Enter as send and uses Shift+Enter for composer newlines", async () => {
    const controller = createController({ sessionToken: "token-123" });
    const sentMessages: string[] = [];
    apiClient.connectChannel = (() => ({
      send: async (content: string) => {
        sentMessages.push(content);
        return {
          id: `server:${sentMessages.length}`,
          channelId: "everyone",
          content,
          replyToId: null,
          createdAt: "2026-03-30T00:00:30.000Z",
          user: { id: "u0", username: "ada", displayName: "Ada" },
        };
      },
      close: () => {},
    })) as typeof apiClient.connectChannel;

    await mountChat(controller);

    const frameBeforeClick = tui.frame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("first line");
      await tui.setup().renderOnce();
    });

    await emitKeypress({ name: "return", sequence: "\r", shift: true });

    await act(async () => {
      await tui.setup().mockInput.typeText("second line");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frameAfterNewline = tui.frame();
    expect(frameAfterNewline).toContain("first line");
    expect(frameAfterNewline).toContain("second line");
    expect(sentMessages).toEqual([]);

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(sentMessages).toEqual(["first line\nsecond line"]);
  });

  test("clears the composer locally after an accepted send", async () => {
    const controller = createController({ sessionToken: "token-123" });
    const sentMessages: string[] = [];
    (controller as any).send = (content: string) => {
      sentMessages.push(content);
      return true;
    };
    (controller as any).setDraft = () => {};

    await mountChat(controller);

    const frameBeforeClick = tui.frame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("hello");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    // Enter on a draft the input has not taken yet sends nothing.
    await tui.waitForFrameToContain("> hello");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(sentMessages).toEqual(["hello"]);
    expect(tui.frame()).not.toContain("> hello");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(sentMessages).toEqual(["hello"]);
  });

  test("runs /discord commands instead of posting them to the channel", async () => {
    const controller = createController({ sessionToken: "token-123" });
    const sentMessages: string[] = [];
    (controller as any).send = (content: string) => {
      sentMessages.push(content);
      return true;
    };
    const originalSetMirror = apiClient.setChatDiscordMirror;
    const mirrorCalls: boolean[] = [];
    apiClient.setChatDiscordMirror = async (enabled) => { mirrorCalls.push(enabled); };
    try {
      await renderFocusedComposerWithDraft(controller, "/discord mirror off");
      await tui.waitForFrameToContain("> /discord mirror off");

      await act(async () => {
        tui.setup().mockInput.pressEnter();
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });

      expect(mirrorCalls).toEqual([false]);
      expect(sentMessages).toEqual([]);
      expect(tui.frame()).not.toContain("/discord mirror off");
    } finally {
      apiClient.setChatDiscordMirror = originalSetMirror;
    }
  });

  test("keeps typed shortcut letters in the composer instead of moving message selection", async () => {
    const controller = createController({
      messages: Array.from({ length: 18 }, (_, index) => makeMessage(index + 1)),
    });

    await mountChat(controller);

    const frameBeforeClick = tui.frame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Type a message..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Type a message...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(inputCol + 1, inputRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await act(async () => {
      await tui.setup().mockInput.typeText("g");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frameAfterType = tui.frame();
    expect(frameAfterType).toContain("> g");
    expect(frameAfterType).not.toContain("user1 3/30/26");
    expect(frameAfterType).not.toContain("message 1 ");
  });

  describe("pending sends", () => {
    const makePending = (
      createdAt: string,
      clientStatus: ChatMessage["clientStatus"] = "sending",
    ): ChatMessage => ({
      id: "local:1",
      channelId: "everyone",
      content: "hello pending",
      replyToId: null,
      createdAt,
      user: { id: "u0", username: "ada", displayName: "Ada" },
      clientStatus,
      clientError: clientStatus === "failed" ? "Failed to send message." : null,
    });

    function bodyColor(text: string): string | undefined {
      const line = tui.setup().captureSpans().lines.find((entry) => lineText(entry).includes(text));
      return line?.spans.find((span) => span.text.includes(text))?.fg.toInts().join(",");
    }

    test("draws a fresh pending send like a sent message", async () => {
      const controller = createController({ messages: [makePending(recentChatTimestamp(0))] });

      await mountChat(controller);

      const frame = tui.frame();
      expect(frame).toContain("hello pending");
      expect(frame).toContain("just now");
      expect(frame).not.toContain("sending...");
      expect(bodyColor("hello pending")).toBe(hexToRgbaInts(colors.text));
    });

    test("falls back to the dim sending state once a send is slow", async () => {
      const controller = createController({
        messages: [makePending(recentChatTimestamp(SLOW_SEND_THRESHOLD_MS + 1_000))],
      });

      await mountChat(controller);

      expect(tui.frame()).toContain("sending...");
      expect(bodyColor("hello pending")).toBe(hexToRgbaInts(colors.textDim));
    });

    test("turns a fresh pending send dim when it is still pending after the threshold", async () => {
      const controller = createController({
        messages: [makePending(recentChatTimestamp(SLOW_SEND_THRESHOLD_MS - 250))],
      });

      await mountChat(controller);
      expect(tui.frame()).not.toContain("sending...");

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      await flushFrame();

      expect(tui.frame()).toContain("sending...");
      expect(bodyColor("hello pending")).toBe(hexToRgbaInts(colors.textDim));
    });

    test("keeps a failed send red and marked as failed", async () => {
      const controller = createController({ messages: [makePending(recentChatTimestamp(0), "failed")] });

      await mountChat(controller);

      const frame = tui.frame();
      expect(frame).toContain("failed");
      expect(frame).not.toContain("sending...");
      expect(bodyColor("hello pending")).toBe(hexToRgbaInts(colors.negative));
    });
  });

  test("auto-scrolls to newly appended messages while following the latest transcript", async () => {
    const controller = createController({
      messages: [
        makeMessage(1),
        makeMessage(2),
        makeMessage(3),
        makeMessage(4),
        makeMessage(5),
        makeMessage(6),
      ],
    });

    await mountChat(controller, { width: 60, height: 13, withFooter: true });

    const frameBeforeUpdate = tui.frame();
    expect(frameBeforeUpdate).toContain("message 6");
    expect(frameBeforeUpdate).not.toContain("message 1");

    await act(async () => {
      (controller as any).mergeMessages([makeMessage(7)]);
    });

    await flushFrame();

    const frameAfterUpdate = tui.frame();
    expect(frameAfterUpdate).not.toContain("7 messages");
    expect(frameAfterUpdate).toContain("message 7");
    expect(frameAfterUpdate).not.toContain("message 1");
  });

  test("loads older messages at the top without jumping away from the current transcript", async () => {
    const controller = createController({
      messages: [
        makeMessage(4),
        makeMessage(5),
        makeMessage(6),
        makeMessage(7),
        makeMessage(8),
        makeMessage(9),
        makeMessage(10),
      ],
    });
    let loadCount = 0;
    controller.loadOlderMessages = async () => {
      loadCount += 1;
      (controller as any).mergeMessages([
        makeMessage(1),
        makeMessage(2),
        makeMessage(3),
      ], { notifyMentions: false });
    };

    await mountChat(controller, { width: 60, height: 13 });
    expect(tui.frame()).toContain("message 10");

    await emitKeypress({ name: "g", sequence: "g" });
    await flushFrame();

    expect(loadCount).toBe(1);
    expect(controller.getSnapshot().messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "m10",
    ]);
    const frame = tui.frame();
    expect(frame).toContain("message 4");
    expect(frame).not.toContain("message 1");
  });

  test("selects nothing when scrolling to the top loads older messages", async () => {
    const controller = createController({
      messages: [makeMessage(4), makeMessage(5), makeMessage(6), makeMessage(7), makeMessage(8), makeMessage(9), makeMessage(10)],
    });
    let loadCount = 0;
    controller.loadOlderMessages = async () => {
      loadCount += 1;
      (controller as any).mergeMessages([makeMessage(1), makeMessage(2), makeMessage(3)], { notifyMentions: false });
    };

    await mountChat(controller, { width: 60, height: 13 });
    // By wheel, as a mouse reader does: no key puts a cursor on a message.
    for (let turn = 0; turn < 12; turn += 1) {
      await act(async () => {
        await tui.setup().mockMouse.scroll(20, 4, "up");
        await tui.setup().renderOnce();
      });
    }
    await flushFrame();

    expect(loadCount).toBeGreaterThan(0);
    const rowBg = (text: string) => tui.setup().captureSpans().lines
      .filter((line) => lineText(line).includes(text))
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes(text))?.bg.toInts().join(",");
    // The message that was at the top before the page came in, and the one the reader sees now.
    expect(rowBg("message 4")).not.toBe(hexToRgbaInts(colors.selected));
  });

  test("renders ticker badges and opens a floating Ticker Research pane on click", async () => {
    const controller = createController({
      messages: [{
        id: "m1",
        channelId: "everyone",
        content: "Watching $TSLA today",
        replyToId: null,
        createdAt: "2026-03-28T00:00:00.000Z",
        user: { id: "u1", username: "ada", displayName: "Ada" },
      }],
    });
    const opened: string[] = [];

    setSharedRegistryForTests({
      pinTicker(symbol: string) {
        opened.push(symbol);
      },
    } as any);

    await mountChat(controller, {
      width: 60,
      height: 12,
      configureState(state) {
        state.tickers = new Map([["TSLA", createTestTicker("TSLA", "Tesla, Inc.")]]);
        state.financials = new Map([["TSLA", createTestFinancials({
          quote: {
            symbol: "TSLA",
            price: 250,
            currency: "USD",
            change: -12.5,
            changePercent: -5,
            lastUpdated: Date.now(),
          },
        })]]);
      },
    });

    const lines = tui.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("TSLA -5.0%"));
    const col = lines[row]?.indexOf("TSLA -5.0%") ?? -1;

    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(col + 1, row);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(opened).toEqual(["TSLA"]);
  });

  test("wraps ticker badges using their rendered width in terminal messages", async () => {
    const controller = createController({
      messages: [{
        id: "m1",
        channelId: "everyone",
        content: "For example for $META it seems to look at Meta AI revenue, not mentioning the ad engine where revenues are most likely to translate",
        replyToId: null,
        createdAt: "2026-03-28T00:00:00.000Z",
        user: { id: "u1", username: "ada", displayName: "Ada" },
      }],
    });

    await mountChat(controller, {
      width: 60,
      height: 12,
      configureState(state) {
        state.tickers = new Map([["META", createTestTicker("META", "Meta Platforms, Inc.")]]);
        state.financials = new Map([["META", createTestFinancials({
          quote: {
            symbol: "META",
            price: 650,
            currency: "USD",
            change: -3.25,
            changePercent: -0.5,
            lastUpdated: Date.now(),
          },
        })]]);
      },
    });

    const frame = tui.frame();
    const normalizedFrame = frame.replace(/\s+/g, " ");
    expect(normalizedFrame).toContain("For example for META -0.5%");
    expect(normalizedFrame).toContain("it seems to look at Meta AI revenue, not");
    expect(normalizedFrame).toContain("mentioning the ad engine where revenues");
    expect(frame).not.toContain("mentioningttheoad");
  });

  test("keeps long link query strings from spilling into following terminal rows", async () => {
    const controller = createController({
      messages: [{
        id: "m1",
        channelId: "everyone",
        content: "again:\nhttps://github.com/houmain/keymapper/issues?weird_one=the_rest_of the query parameters got lost entirely :)",
        replyToId: null,
        createdAt: "2026-03-28T00:00:00.000Z",
        user: { id: "u1", username: "ada", displayName: "Ada" },
      }],
    });

    await mountChat(controller);

    const frame = tui.frame();
    expect(frame).toContain("https://github.com/houmain/keymapper/issues?weird_one=");
    expect(frame).toContain("the_rest_of the query parameters got lost entirely :)");
    expect(frame).not.toContain("therquery=parametersfgot");
  });

  test("draws a row per image in the terminal, with no blank text row for an image-only message", async () => {
    const image = (id: string, width: number, height: number, size: number) => ({
      id, mime: "image/png", width, height, size, url: `https://api.example/chat/attachments/${id}`,
    });
    const controller = createController({
      messages: [
        {
          id: "m1",
          channelId: "everyone",
          content: "",
          replyToId: null,
          createdAt: "2026-03-28T00:00:00.000Z",
          user: { id: "u1", username: "bob", displayName: "Bob" },
          attachments: [image("img_a", 1280, 720, 183_422)],
        },
        {
          id: "m2",
          channelId: "everyone",
          content: "my chart",
          replyToId: "m1",
          replyTo: { content: "", user: { username: "bob" }, attachmentCount: 1 },
          createdAt: "2026-03-28T00:10:00.000Z",
          user: { id: "u0", username: "ada", displayName: "Ada" },
          attachments: [image("img_b", 800, 600, 1_258_291)],
          attachmentReview: "pending",
        },
      ],
    });

    await mountChat(controller, { width: 60, height: 16 });

    const rows = tui.frame().split("\n").map((row) => row.trimEnd());
    const header = rows.findIndex((row) => row.startsWith(" bob "));
    expect(rows[header + 1]).toContain("[image 1280x720 179 KB]");
    expect(tui.frame()).toContain("reply bob: [image]");
    const caption = rows.findIndex((row) => row.includes("my chart"));
    expect(rows[caption + 1]).toContain("[image 800x600 1.2 MB]");
    expect(rows[caption + 2]).toContain("Checking image...");
  });

  test("tags messages that came from Discord, and signs a ghost with its Discord name", async () => {
    const at = (second: number) => `2026-03-28T00:00:${String(second).padStart(2, "0")}.000Z`;
    const bob = { id: "u1", username: "bob", displayName: "Bob" };
    const controller = createController({
      messages: [
        { id: "m1", channelId: "everyone", content: "from the app", replyToId: null, createdAt: at(0), user: bob },
        // The same person, writing from Discord a moment later: the tag needs a header of its own.
        { id: "m2", channelId: "everyone", content: "from the other side", replyToId: null, createdAt: at(10), user: bob, origin: "discord" },
        {
          id: "m3", channelId: "everyone", content: "a guest speaking", replyToId: null, createdAt: at(20),
          user: { id: "d1", username: null, displayName: "Grace H", accountType: "discord" }, origin: "discord",
        },
        // Values a newer server adds read as an app message from a human.
        {
          id: "m4", channelId: "everyone", content: "from somewhere new", replyToId: null, createdAt: at(30),
          user: { id: "u4", username: "cy", displayName: "Cy", accountType: "bot" as never }, origin: "slack" as never,
        },
      ],
    });

    await mountChat(controller, { width: 60, height: 18 });

    const rows = tui.frame().split("\n").map((row) => row.trimEnd());
    const header = (author: string) => rows.find((row) => row.startsWith(` ${author} `))!;
    expect(rows.filter((row) => row.startsWith(" bob "))).toHaveLength(2);
    expect(header("bob")).not.toContain("Discord");
    expect(rows.filter((row) => row.startsWith(" bob ") && row.includes("Discord"))).toHaveLength(1);
    expect(header("Grace H")).toContain("Discord");
    expect(header("cy")).not.toContain("Discord");

    // Every name opens a card but a Discord ghost's: there is no profile and no one to message.
    await tui.clickFrameText("Grace H");
    await flushFrame();
    expect(tui.frame().split("Grace H")).toHaveLength(2);
    await tui.clickFrameText(" cy ");
    await flushFrame();
    expect(tui.frame()).toContain("@cy");
  });

  test("badges a bot as AI in its own colour, staff as Team and Pro accounts as Pro, never a Discord ghost", async () => {
    const at = (second: number) => `2026-03-28T00:00:${String(second).padStart(2, "0")}.000Z`;
    const controller = createController({
      messages: [
        { id: "m1", channelId: "everyone", content: "ask me anything", replyToId: null, createdAt: at(0), user: { id: "b1", username: "gloombot", displayName: "Gloombot", accountType: "managed_llm" } },
        { id: "m2", channelId: "everyone", content: "from a person", replyToId: null, createdAt: at(10), user: { id: "u1", username: "bob", displayName: "Bob", accountType: "human" } },
        { id: "m3", channelId: "everyone", content: "a guest speaking", replyToId: null, createdAt: at(20), user: { id: "d1", username: null, displayName: "Grace H", accountType: "discord" }, origin: "discord" },
        { id: "m4", channelId: "everyone", content: "shipping it", replyToId: null, createdAt: at(30), user: { id: "s1", username: "wren", displayName: "Wren", accountType: "human", badges: ["team", "pro"], utcOffsetMinutes: 120, desks: ["options", "futures"] } },
        { id: "m5", channelId: "everyone", content: "long only", replyToId: null, createdAt: at(40), user: { id: "p1", username: "otto", displayName: "Otto", accountType: "human", badges: ["pro"] } },
      ],
    });

    await mountChat(controller, { width: 60, height: 24 });

    const rows = tui.frame().split("\n").map((row) => row.trimEnd());
    const header = (author: string) => rows.find((row) => row.startsWith(` ${author} `))!;
    expect(header("gloombot")).toContain(" AI ");
    expect(header("bob")).not.toMatch(/ (AI|Team|Pro) /);
    expect(header("Grace H")).not.toMatch(/ (AI|Team|Pro) /);
    expect(header("wren")).toMatch(/ wren +Team +Pro /);
    expect(header("otto")).toContain(" Pro ");
    expect(header("otto")).not.toContain("Team");

    // A bot's name has its own colour; a person's keeps the one every name has.
    const nameColour = (name: string) => tui.setup().captureSpans().lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.trim() === name)?.fg.toInts().join(",");
    expect(nameColour("gloombot")).toBe(hexToRgbaInts(chatBotNameColor()));
    expect(nameColour("bob")).toBe(hexToRgbaInts(colors.positive));

    // The badge is not a target of its own: the name still opens the card, which says what the account is.
    await tui.clickFrameText("gloombot");
    await flushFrame();
    expect(tui.frame()).toContain("AI bot run by Gloom");
    expect(tui.frame()).not.toContain("Local time");

    // A person's card has their role, their local time and the desks they chose to show.
    await emitKeypress({ name: "escape", sequence: "\u001b" });
    await flushFrame();
    await tui.clickFrameText("wren");
    await flushFrame();
    const card = tui.frame();
    expect(card).toContain("Gloom team · Pro");
    expect(card).toMatch(/Local time \d\d:\d\d/);
    expect(card).toContain("Trades Options, Futures");
  });

  test("a narrow terminal row drops the Pro badge before the role, and a hidden clock never shows", async () => {
    const controller = createController({
      messages: [
        { id: "m1", channelId: "everyone", content: "hi", replyToId: null, createdAt: "2026-03-28T00:00:00.000Z", user: { id: "s1", username: "longer_staff_name", displayName: "Staff", accountType: "human", badges: ["team", "pro"] } },
      ],
    });

    await mountChat(controller, { width: 48, height: 12 });

    const header = tui.frame().split("\n").find((row) => row.startsWith(" longer_staff_name "))!;
    expect(header).toContain(" Team ");
    expect(header).not.toContain("Pro");

    await tui.clickFrameText("longer_staff_name");
    await flushFrame();
    expect(tui.frame()).toContain("Gloom team · Pro");
    expect(tui.frame()).not.toContain("Local time");
  });

  test("shows a saved-login read-only footer when a session token is cached", async () => {
    const controller = createController({
      sessionToken: "token-123",
      user: null,
    });

    await mountChat(controller);

    const frame = tui.frame();
    expect(frame).toContain("Saved login found.");
    expect(frame).toContain("Log in again to send.");
    expect(frame).toContain("No messages yet.");
    expect(frame).not.toContain("Type a message...");
  });

  test("keeps the transcript visible for logged-out users and blocks the composer, down to a narrow pane", async () => {
    for (const width of [60, 27]) {
      const controller = createController({
        sessionToken: null,
        user: null,
        messages: [makeMessage(1)],
      });

      await mountChat(controller, { width });

      const frame = tui.frame();
      expect(frame).toContain("message 1");
      expect(frame).toContain("Read-only chat.");
      expect(frame).toContain("Log in");
      expect(frame).toContain("Sign up free");
      expect(frame).not.toContain("Type a message...");
    }
  });

  test("shows a logged-in icon in the cloud status widget for cached sessions", async () => {
    const controller = createController({
      sessionToken: "token-123",
      user: null,
    });
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    state.config.disabledPlugins = [];

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
            <ChatStatusWidget controller={controller} />
          </PluginRenderProvider>
        </AppContext>,
        { width: 40, height: 1 },
      );
    });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("@");
    expect(frame).not.toContain("Shift+C");
    expect(frame).not.toContain("ada");
  });

  test("shows clickable login actions instead of the cloud shortcut when logged out", async () => {
    const controller = createController({
      sessionToken: null,
      user: null,
    });
    const openedQueries: string[] = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    state.config.disabledPlugins = [];

    const runtime = createTestPluginRuntime({
      openCommandBar(query?: string) {
        openedQueries.push(query ?? "");
      },
    });

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
            <ChatStatusWidget controller={controller} />
          </PluginRenderProvider>
        </AppContext>,
        { width: 40, height: 1 },
      );
    });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("☁");
    expect(frame).toContain("Log in");
    expect(frame).not.toContain("Sign up");
    expect(frame).not.toContain("Shift+C");

    const line = frame.split("\n")[0] ?? "";
    const loginCol = line.indexOf("Log in");

    expect(loginCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(loginCol + 1, 0);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(openedQueries).toEqual(["Log In"]);
  });

  test("shows an unread mention badge and opens chat from the status widget", async () => {
    const controller = createController({
      sessionToken: "token-123",
      user: { id: "u1", username: "ada", emailVerified: true },
    });
    const openedTemplates: Array<{ templateId: string; options?: { arg?: string } }> = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    state.config.disabledPlugins = [];

    const runtime = createTestPluginRuntime({
      createPaneFromTemplate(templateId: string, options?: { arg?: string }) {
        openedTemplates.push({ templateId, options });
      },
    });

    await act(async () => {
      (controller as any).mergeMessages([{
        id: "m1",
        channelId: "everyone",
        content: "pinging @ada before the bell",
        replyToId: null,
        createdAt: "2026-03-28T00:00:00.000Z",
        user: { id: "u2", username: "bob", displayName: "Bob" },
      } satisfies ChatMessage]);
    });

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
            <ChatStatusWidget controller={controller} />
          </PluginRenderProvider>
        </AppContext>,
        { width: 40, height: 1 },
      );
    });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("ada");
    expect(frame).toContain("[1]");

    const line = frame.split("\n")[0] ?? "";
    const nameCol = line.indexOf("ada");
    const badgeCol = line.indexOf("[1]");

    expect(nameCol).toBeGreaterThanOrEqual(0);
    expect(badgeCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(nameCol, 0);
      await tui.setup().renderOnce();
      await tui.setup().mockMouse.click(badgeCol + 1, 0);
      await tui.setup().renderOnce();
    });

    expect(openedTemplates).toEqual([
      { templateId: "new-chat-pane", options: { arg: "everyone" } },
      { templateId: "unread-inbox-pane", options: undefined },
    ]);
  });

  test("opens an unread direct-message channel from the status widget", async () => {
    const controller = createController({
      sessionToken: "token-123",
      user: { id: "u1", username: "ada", emailVerified: true },
    });
    const dmChannelId = "dm:test";
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      {
        id: dmChannelId,
        name: "@bob",
        kind: "direct",
        created_at: "2026-05-27T10:30:03.712Z",
        dmUser: { id: "u2", username: "bob", displayName: "Bob" },
      },
    ]);
    const openedTemplates: Array<{ templateId: string; options?: { arg?: string } }> = [];
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    state.config.disabledPlugins = [];

    const runtime = createTestPluginRuntime({
      createPaneFromTemplate(templateId: string, options?: { arg?: string }) {
        openedTemplates.push({ templateId, options });
      },
    });

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
            <ChatStatusWidget controller={controller} />
          </PluginRenderProvider>
        </AppContext>,
        { width: 40, height: 1 },
      );
    });

    await flushFrame();

    await act(async () => {
      (controller as any).mergeMessages(dmChannelId, [{
        id: "dm-m1",
        channelId: dmChannelId,
        content: "private ping",
        replyToId: null,
        createdAt: "2026-05-27T10:31:00.000Z",
        user: { id: "u2", username: "bob", displayName: "Bob" },
      } satisfies ChatMessage]);
    });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("ada");
    expect(frame).toContain("[1]");

    const line = frame.split("\n")[0] ?? "";
    const nameCol = line.indexOf("ada");
    const badgeCol = line.indexOf("[1]");

    expect(nameCol).toBeGreaterThanOrEqual(0);
    expect(badgeCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(nameCol, 0);
      await tui.setup().renderOnce();
      await tui.setup().mockMouse.click(badgeCol + 1, 0);
      await tui.setup().renderOnce();
    });

    expect(openedTemplates).toEqual([
      { templateId: "new-chat-pane", options: { arg: dmChannelId } },
      { templateId: "unread-inbox-pane", options: undefined },
    ]);
  });

});
