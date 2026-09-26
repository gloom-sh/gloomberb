import { describe, expect, test } from "bun:test";
import {
  clearChatPaneTargetMessage,
  setChatPaneChannel,
} from "./pane-state";

describe("chat pane state", () => {
  test("preserves an exact-message target while the current channel metadata updates", () => {
    expect(setChatPaneChannel({
      channelId: "direct:ada:bob",
      targetMessageId: "message-42",
    }, "direct:ada:bob")).toEqual({
      channelId: "direct:ada:bob",
      targetMessageId: "message-42",
    });
  });

  test("clears an exact-message target when the user changes channels", () => {
    expect(setChatPaneChannel({
      channelId: "direct:ada:bob",
      targetMessageId: "message-42",
    }, "everyone")).toEqual({ channelId: "everyone" });
  });

  test("clears the target only after the message jump is handled", () => {
    expect(clearChatPaneTargetMessage({
      channelId: "direct:ada:bob",
      targetMessageId: "message-42",
    })).toEqual({ channelId: "direct:ada:bob" });
  });
});
