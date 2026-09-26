import { afterEach, describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import type { ChatMessage } from "../../../../api-client";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { useChatComposerRuntime } from "./composer-runtime";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy();
    });
  }
  testSetup = undefined;
});

describe("useChatComposerRuntime", () => {
  test("sends to the pending channel ref instead of the stale rendered channel", async () => {
    const sent: Array<{ channelId: string; content: string; replyToId?: string }> = [];
    let sendMessage = () => {};

    function Harness() {
      const applyingExternalDraftRef = useRef(false);
      const channelIdRef = useRef("dm:test");
      const inputRef = useRef(null);
      const inputValueRef = useRef("PM reply test #2");
      sendMessage = useChatComposerRuntime({
        applyingExternalDraftRef,
        blurInput: () => {},
        canSend: true,
        channelId: "everyone",
        channelIdRef,
        contentWidth: 80,
        controller: {
          send: () => false,
          sendToChannel: (channelId, content, replyToId) => {
            sent.push({ channelId, content, replyToId });
            return true;
          },
          openDirectChannel: async () => { throw new Error("not used"); },
          openGroupChannel: async () => { throw new Error("not used"); },
          setDraft: () => {},
          setChannelDraft: () => {},
          setReplyToId: () => {},
          setChannelReplyToId: () => {},
        } as any,
        focusInput: () => {},
        focused: true,
        inputFocused: true,
        inputRef,
        inputValueRef,
        messages: [],
        onChannelChange: () => {},
        replyTo: null,
        setDirectExpanded: () => {},
        setFollowMessages: () => {},
        setReplyTo: () => {},
        setSelectedIdx: () => {},
        updateComposerRows: () => {},
        useDefaultControllerChannel: false,
      }).sendMessage;
      return null;
    }

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 1, height: 1 });
    });

    await act(async () => {
      sendMessage();
      await testSetup?.renderOnce();
    });

    expect(sent).toEqual([{ channelId: "dm:test", content: "PM reply test #2", replyToId: undefined }]);
  });

  test("drops a reply target from a different channel before sending", async () => {
    const sent: Array<{ channelId: string; content: string; replyToId?: string }> = [];
    let sendMessage = () => {};
    const staleReply: ChatMessage = {
      id: "public-reply",
      channelId: "everyone",
      content: "public message",
      replyToId: null,
      createdAt: "2026-05-27T10:26:44.737Z",
      user: { id: "u2", username: "ada", displayName: "Ada" },
    };

    function Harness() {
      const applyingExternalDraftRef = useRef(false);
      const channelIdRef = useRef("dm:test");
      const inputRef = useRef(null);
      const inputValueRef = useRef("replying in DM");
      sendMessage = useChatComposerRuntime({
        applyingExternalDraftRef,
        blurInput: () => {},
        canSend: true,
        channelId: "dm:test",
        channelIdRef,
        contentWidth: 80,
        controller: {
          send: () => false,
          sendToChannel: (channelId, content, replyToId) => {
            sent.push({ channelId, content, replyToId });
            return true;
          },
          openDirectChannel: async () => { throw new Error("not used"); },
          openGroupChannel: async () => { throw new Error("not used"); },
          setDraft: () => {},
          setChannelDraft: () => {},
          setReplyToId: () => {},
          setChannelReplyToId: () => {},
        } as any,
        focusInput: () => {},
        focused: true,
        inputFocused: true,
        inputRef,
        inputValueRef,
        messages: [],
        onChannelChange: () => {},
        replyTo: staleReply,
        setDirectExpanded: () => {},
        setFollowMessages: () => {},
        setReplyTo: () => {},
        setSelectedIdx: () => {},
        updateComposerRows: () => {},
        useDefaultControllerChannel: false,
      }).sendMessage;
      return null;
    }

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 1, height: 1 });
    });

    await act(async () => {
      sendMessage();
      await testSetup?.renderOnce();
    });

    expect(sent).toEqual([{ channelId: "dm:test", content: "replying in DM", replyToId: undefined }]);
  });
});
