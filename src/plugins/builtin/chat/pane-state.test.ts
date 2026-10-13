import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type AppConfig, type PaneInstanceConfig } from "../../../types/config";
import { applyUnreadInboxItemToConfig, setChatPaneChannel } from "./pane-state";

function configWithFloating(instances: PaneInstanceConfig[]): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-chat-pane-state");
  return {
    ...config,
    layout: {
      dockRoot: null,
      instances,
      floating: instances.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: 0, width: 60, height: 16 })),
      detached: [],
    },
  };
}

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

  test("an unread row opens in the chat pane already on its channel and closes the list", () => {
    const config = configWithFloating([
      { instanceId: "chat:everyone", paneId: "chat", title: "#everyone", settings: { channelId: "everyone", targetMessageId: "old" } },
      { instanceId: "chat:macro", paneId: "chat", title: "#macro", settings: { channelId: "macro" } },
      { instanceId: "unread-inbox", paneId: "unread-inbox", title: "Unread" },
    ]);

    const jump = applyUnreadInboxItemToConfig(config, { channelId: "macro", messageId: "m9", paneTitle: "#macro" }, "unread-inbox");
    expect(jump.chatInstanceId).toBe("chat:macro");
    expect(jump.config.layout.instances.map((instance) => [instance.instanceId, instance.settings])).toEqual([
      ["chat:everyone", { channelId: "everyone", targetMessageId: "old" }],
      ["chat:macro", { channelId: "macro", targetMessageId: "m9" }],
    ]);

    // A row with no known message opens the channel without a stale target.
    const open = applyUnreadInboxItemToConfig(config, { channelId: "everyone", messageId: null, paneTitle: "#everyone" });
    expect(open.chatInstanceId).toBe("chat:everyone");
    expect(open.config.layout.instances.find((instance) => instance.instanceId === "chat:everyone")?.settings).toEqual({ channelId: "everyone" });
  });

  test("with no pane on the channel, an unread row opens in the focused chat pane, else the one in front", () => {
    const config = configWithFloating([
      { instanceId: "chat:a", paneId: "chat", title: "#everyone", settings: { channelId: "everyone" } },
      { instanceId: "chat:b", paneId: "chat", title: "#macro", settings: { channelId: "macro" } },
      { instanceId: "unread-inbox", paneId: "unread-inbox", title: "Unread" },
    ]);
    config.layout.floating[0]!.zIndex = 52;
    config.layout.floating[1]!.zIndex = 51;
    const row = { channelId: "trading", messageId: "m1", paneTitle: "#trading" };

    // The first chat pane in the list is not the one the user was last using.
    expect(applyUnreadInboxItemToConfig(config, row, "unread-inbox", "chat:b").chatInstanceId).toBe("chat:b");
    expect(applyUnreadInboxItemToConfig(config, row, "unread-inbox", "unread-inbox").chatInstanceId).toBe("chat:a");

    const swapped = configWithFloating(config.layout.instances);
    swapped.layout.floating[0]!.zIndex = 50;
    swapped.layout.floating[1]!.zIndex = 53;
    expect(applyUnreadInboxItemToConfig(swapped, row, "unread-inbox", null).chatInstanceId).toBe("chat:b");
  });
});
