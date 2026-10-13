/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import type { ChatMessage } from "../../../../api-client";
import { createDomTestHarness } from "../../../../renderers/dom/test-utils";
import { makeMessage } from "../test-harness";
import { useChatScrollRuntime } from "./scroll";
import type { ChatContentController } from "./types";

const { render } = createDomTestHarness({ withUi: false });
const ignore = () => {};

/** The scroll runtime as ChatContent runs it, with the width and the messages in the test's hands. */
function Runtime({ seen, change }: {
  seen: Array<(messageId: string) => void>;
  change: { set?: (next: { width: number; messages: ChatMessage[] }) => void };
}) {
  const [{ width, messages }, set] = useState({ width: 80, messages: [makeMessage(1), makeMessage(2)] });
  change.set = set;
  const { jumpToMessage } = useChatScrollRuntime({
    channelId: "everyone",
    catalog: {},
    contentWidth: width - 2,
    controller: {} as ChatContentController,
    focused: true,
    hasOlderMessages: true,
    height: 24,
    latestMessage: messages.at(-1) ?? null,
    loadingOlderMessages: false,
    messageAreaHeight: 20,
    messageElementsRef: { current: new Map() },
    messages,
    nativePaneChrome: true,
    prependAnchorRef: { current: null },
    scrollRef: { current: null },
    selectedIdx: -1,
    selectionActive: false,
    setFollowMessages: ignore,
    setSelectedIdx: ignore,
    stickyTranscript: true,
    useDefaultControllerChannel: true,
    highlightMessage: ignore,
    clearHover: ignore,
    clearHighlight: ignore,
  });
  seen.push(jumpToMessage);
  return null;
}

test("every message row is handed the same jump function through a resize and new messages, so the rows do not draw again", async () => {
  const seen: Array<(messageId: string) => void> = [];
  const change: { set?: (next: { width: number; messages: ChatMessage[] }) => void } = {};
  await render(<Runtime seen={seen} change={change} />);

  await act(async () => change.set?.({ width: 72, messages: [makeMessage(1), makeMessage(2)] }));
  await act(async () => change.set?.({ width: 72, messages: [makeMessage(1), makeMessage(2), makeMessage(3)] }));

  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(new Set(seen).size).toBe(1);
});
