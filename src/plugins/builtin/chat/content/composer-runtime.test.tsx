import { describe, expect, test } from "bun:test";
import { act, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { ChatMessage } from "../../../../api-client";
import type { TextareaRenderable } from "../../../../ui";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { useChatComposerRuntime } from "./composer-runtime";
import type { ChatContentController } from "./types";

const tui = createOpenTuiTestHarness();

type SentMessage = { channelId: string; content: string; replyToId?: string };

/** Records sends. The composer never makes the controller calls left out here. */
function sendingController(sent: SentMessage[]): ChatContentController {
  const controller: Partial<ChatContentController> = {
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
  };
  return controller as ChatContentController;
}

describe("useChatComposerRuntime", () => {
  test("sends to the pending channel ref instead of the stale rendered channel", async () => {
    const sent: SentMessage[] = [];
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
        controller: sendingController(sent),
        focusInput: () => {},
        focused: true,
        inputFocused: true,
        inputRef,
        inputValueRef,
        messages: [],
        onChannelChange: () => {},
        replyTo: null,
        editingMessage: null,
        latestEditableMessageId: null,
        setEditingMessage: () => {},
        expandDirectSection: () => {},
        setFollowMessages: () => {},
        setReplyTo: () => {},
        setSelectedIdx: () => {},
        updateComposerRows: () => {},
        useDefaultControllerChannel: false,
      }).sendMessage;
      return null;
    }

    await act(async () => {
      await tui.render(<Harness />, { width: 1, height: 1 });
    });

    await act(async () => {
      sendMessage();
      await tui.setup().renderOnce();
    });

    expect(sent).toEqual([{ channelId: "dm:test", content: "PM reply test #2", replyToId: undefined }]);
  });

  test("drops a reply target from a different channel before sending", async () => {
    const sent: SentMessage[] = [];
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
        controller: sendingController(sent),
        focusInput: () => {},
        focused: true,
        inputFocused: true,
        inputRef,
        inputValueRef,
        messages: [],
        onChannelChange: () => {},
        replyTo: staleReply,
        editingMessage: null,
        latestEditableMessageId: null,
        setEditingMessage: () => {},
        expandDirectSection: () => {},
        setFollowMessages: () => {},
        setReplyTo: () => {},
        setSelectedIdx: () => {},
        updateComposerRows: () => {},
        useDefaultControllerChannel: false,
      }).sendMessage;
      return null;
    }

    await act(async () => {
      await tui.render(<Harness />, { width: 1, height: 1 });
    });

    await act(async () => {
      sendMessage();
      await tui.setup().renderOnce();
    });

    expect(sent).toEqual([{ channelId: "dm:test", content: "replying in DM", replyToId: undefined }]);
  });

  describe("textarea binding", () => {
    /** The part of the terminal textarea the composer reads: its text, and the callback it fires on an edit. */
    function fakeTextarea() {
      let text = "";
      const textarea = {
        editBuffer: { getText: () => text },
        onContentChange: undefined as (() => void) | undefined,
        setText(next: string) {
          text = next;
          textarea.onContentChange?.();
        },
      };
      return {
        textarea: textarea as unknown as TextareaRenderable,
        type(next: string) {
          text = next;
          textarea.onContentChange?.();
        },
        bound: () => textarea.onContentChange !== undefined,
      };
    }

    /** Mounts its textarea the way the composer does: with the commit, after the hook's own render. */
    function ComposerMount({ inputRef, textarea }: {
      inputRef: MutableRefObject<TextareaRenderable | null>;
      textarea: TextareaRenderable;
    }) {
      useLayoutEffect(() => {
        inputRef.current = textarea;
        return () => {
          inputRef.current = null;
        };
      }, [inputRef, textarea]);
      return null;
    }

    function renderComposer(sent: SentMessage[], drafts: string[]) {
      const inputRef: MutableRefObject<TextareaRenderable | null> = { current: null };
      const inputValueRef = { current: "" };
      // Stable, as the pane's are: a new callback each render would rebind the textarea by accident.
      const updateComposerRows = () => {};
      const view = {
        sendMessage: () => {},
        show: (_textarea: TextareaRenderable | null) => {},
      };
      const controller = {
        ...sendingController(sent),
        setChannelDraft: (_channelId: string, draft: string) => { drafts.push(draft); },
      } as ChatContentController;

      function Harness() {
        const applyingExternalDraftRef = useRef(false);
        const channelIdRef = useRef("everyone");
        const [textarea, setTextarea] = useState<TextareaRenderable | null>(null);
        view.show = setTextarea;
        view.sendMessage = useChatComposerRuntime({
          applyingExternalDraftRef,
          blurInput: () => {},
          canSend: textarea !== null,
          channelId: "everyone",
          channelIdRef,
          contentWidth: 80,
          controller,
          focusInput: () => {},
          focused: true,
          inputFocused: true,
          inputRef,
          inputValueRef,
          messages: [],
          onChannelChange: () => {},
          replyTo: null,
          editingMessage: null,
          latestEditableMessageId: null,
          setEditingMessage: () => {},
          expandDirectSection: () => {},
          setFollowMessages: () => {},
          setReplyTo: () => {},
          setSelectedIdx: () => {},
          updateComposerRows,
          useDefaultControllerChannel: false,
        }).sendMessage;
        return textarea ? <ComposerMount inputRef={inputRef} textarea={textarea} /> : null;
      }

      return { Harness, view };
    }

    test("sends text typed into a textarea that mounts after the first render", async () => {
      // Sign-in or email verification finishing while the pane is open: the
      // composer replaces the "log in" prompt, and nothing else in the hook changes.
      const sent: SentMessage[] = [];
      const drafts: string[] = [];
      const { Harness, view } = renderComposer(sent, drafts);
      const composer = fakeTextarea();

      await act(async () => {
        await tui.render(<Harness />, { width: 1, height: 1 });
      });
      await act(async () => {
        view.show(composer.textarea);
        await tui.setup().renderOnce();
      });

      await act(async () => {
        composer.type("hello after sign-in");
        view.sendMessage();
        await tui.setup().renderOnce();
      });

      expect(drafts).toContain("hello after sign-in");
      expect(sent).toEqual([{ channelId: "everyone", content: "hello after sign-in", replyToId: undefined }]);
    });

    test("follows the textarea when it is replaced, and lets go of the old one", async () => {
      // A narrow pane swaps the thread for the channel list and back, which
      // mounts a new textarea under the same hook.
      const sent: SentMessage[] = [];
      const drafts: string[] = [];
      const { Harness, view } = renderComposer(sent, drafts);
      const first = fakeTextarea();
      const second = fakeTextarea();

      await act(async () => {
        await tui.render(<Harness />, { width: 1, height: 1 });
      });
      await act(async () => {
        view.show(first.textarea);
        await tui.setup().renderOnce();
      });
      await act(async () => {
        view.show(null);
        await tui.setup().renderOnce();
      });
      expect(first.bound()).toBe(false);

      await act(async () => {
        view.show(second.textarea);
        await tui.setup().renderOnce();
      });
      expect(second.bound()).toBe(true);

      await act(async () => {
        second.type("back in the thread");
        view.sendMessage();
        await tui.setup().renderOnce();
      });

      expect(sent).toEqual([{ channelId: "everyone", content: "back in the thread", replyToId: undefined }]);
    });
  });
});
