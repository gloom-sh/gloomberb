import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatChannel } from "../../../api-client";
import { createPaneTemplateOrThrow } from "../../../components/command-bar/workflow/ops";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig, createPaneInstance, findPaneInstance, type LayoutConfig } from "../../../types/config";
import type { PaneTemplateCreateOptions, PaneTemplateDef } from "../../../types/plugin";
import { CHAT_KEEP_CONVERSATION_VALUE, openChatConversation, openChatNewDm } from "./command-bar";
import { chatController } from "./controller";
import { chatModule } from "./index";

const created = "2026-09-01T00:00:00.000Z";
const channel = (id: string, kind: ChatChannel["kind"] = "public"): ChatChannel => ({ id, name: id, kind, created_at: created });

const template = chatModule.paneTemplates!.find((entry) => entry.id === "new-chat-pane") as PaneTemplateDef;
const chatDef = chatModule.panes!.find((entry) => entry.id === "chat")!;

interface OpenChatPane {
  /** The Chat pane, by instance id, the layout shows on which channel. */
  instanceId: string;
  channelId: string;
  /** Stacking order of its floating window: the highest is in front. */
  zIndex?: number;
  targetMessageId?: string;
}

/** The host's side of opening a pane from a template: what it focuses, what it adds, and the layout after. */
async function open(
  panes: OpenChatPane[],
  options: PaneTemplateCreateOptions | undefined,
  focusedPaneId: string | null = null,
) {
  const config = createDefaultConfig("/tmp/gloomberb-chat-open-conversation");
  const layout: LayoutConfig = {
    dockRoot: null,
    instances: panes.map((pane) => createPaneInstance("chat", {
      instanceId: pane.instanceId,
      title: pane.channelId,
      settings: { channelId: pane.channelId, ...(pane.targetMessageId ? { targetMessageId: pane.targetMessageId } : {}) },
    })),
    floating: panes.map((pane, index) => ({
      instanceId: pane.instanceId, x: 0, y: 0, width: 80, height: 30, zIndex: pane.zIndex ?? 50 + index,
    })),
    detached: [],
  };
  const state = { ...createInitialState({ ...config, layout }), focusedPaneId };
  const focused: string[] = [];
  const added: string[] = [];
  const addedSettings: Array<Record<string, unknown> | undefined> = [];
  await createPaneTemplateOrThrow("new-chat-pane", options, {
    dataProvider: createTestDataProvider({ id: "test" }),
    tickerRepository: new JsonTickerRepository(),
    dispatch: () => {},
    getState: () => state,
    pluginRegistry: {
      paneTemplates: new Map([[template.id, template]]),
      panes: new Map([[chatDef.id, chatDef]]),
      getPaneTemplatePluginId: () => undefined,
      getDisabledPaneTemplateOwner: () => null,
      events: { emit: () => {} },
      focusPane: (paneId: string) => { focused.push(paneId); },
      updateLayout: (next: LayoutConfig) => { state.config.layout = next; },
    } as never,
    buildPaneInstance: (paneType, spec) => {
      const instance = createPaneInstance(paneType, spec);
      added.push(instance.instanceId);
      addedSettings.push(instance.settings);
      return instance;
    },
    placePaneInstance: () => {},
  });
  const settings = (instanceId: string) => findPaneInstance(state.config.layout, instanceId)?.settings;
  return { focused, added, addedSettings, settings, title: (instanceId: string) => findPaneInstance(state.config.layout, instanceId)?.title };
}

describe("opening a conversation while a Chat window is open", () => {
  const original = (chatController as any).channelCatalog.channels;
  beforeEach(() => {
    (chatController as any).channelCatalog.channels = [
      channel("everyone"), channel("general"), channel("random"), channel("dm:bob", "direct"),
    ];
  });
  afterEach(() => {
    (chatController as any).channelCatalog.channels = original;
  });

  // A notification, a chat deep link, a share link and the unread list name a message.
  test("a notification focuses the open window and jumps to the message, not a new window", async () => {
    const result = await open(
      [{ instanceId: "chat:everyone", channelId: "everyone" }],
      { arg: "general", values: { messageId: "m42" } },
    );

    expect(result.added).toEqual([]);
    expect(result.focused).toEqual(["chat:everyone"]);
    expect(result.settings("chat:everyone")).toEqual({ channelId: "general", targetMessageId: "m42" });
    expect(result.title("chat:everyone")).toBe("#general");
  });

  test("a message on the channel a window already shows is a jump in that window", async () => {
    const result = await open(
      [{ instanceId: "chat:everyone", channelId: "everyone" }, { instanceId: "chat:general", channelId: "general" }],
      { arg: "everyone", values: { messageId: "m7" } },
    );

    expect(result.added).toEqual([]);
    expect(result.focused).toEqual(["chat:everyone"]);
    expect(result.settings("chat:everyone")).toEqual({ channelId: "everyone", targetMessageId: "m7" });
    expect(result.settings("chat:general")).toEqual({ channelId: "general" });
  });

  // The window's id names the channel it was first opened on; the user has since switched channels in it.
  test("a window the user switched to another channel is still found by the channel it shows", async () => {
    const result = await open([{ instanceId: "chat:everyone", channelId: "general" }], { arg: "general" });

    expect(result.added).toEqual([]);
    expect(result.focused).toEqual(["chat:everyone"]);
    expect(result.settings("chat:everyone")).toEqual({ channelId: "general" });
  });

  test("typing CHAT with a channel switches the open window instead of adding one", async () => {
    const result = await open([{ instanceId: "chat:everyone", channelId: "everyone" }], { arg: "random" }, "chat:everyone");

    expect(result.added).toEqual([]);
    expect(result.focused).toEqual(["chat:everyone"]);
    expect(result.settings("chat:everyone")).toEqual({ channelId: "random" });
  });

  test("a conversation picked in the command bar goes to the open window", async () => {
    const calls: Array<{ arg?: string; values?: Record<string, string> }> = [];
    openChatConversation({ createPaneFromTemplate: (_id, options) => { calls.push(options ?? {}); } }, "dm:bob");
    expect(calls).toEqual([{ arg: "dm:bob" }]);

    const result = await open([{ instanceId: "chat:everyone", channelId: "everyone" }], calls[0]);
    expect(result.added).toEqual([]);
    expect(result.focused).toEqual(["chat:everyone"]);
    expect(result.settings("chat:everyone")).toEqual({ channelId: "dm:bob" });
  });

  test("New DM leaves the open window on its conversation", async () => {
    const calls: Array<PaneTemplateCreateOptions | undefined> = [];
    openChatNewDm({ createPaneFromTemplate: (_id, options) => { calls.push(options); } });
    expect(calls).toEqual([{ values: { [CHAT_KEEP_CONVERSATION_VALUE]: "1" } }]);

    const result = await open([{ instanceId: "chat:everyone", channelId: "random" }], calls[0]);
    expect(result.added).toEqual([]);
    expect(result.focused).toEqual(["chat:everyone"]);
    expect(result.settings("chat:everyone")).toEqual({ channelId: "random" });
  });

  describe("with several Chat windows", () => {
    const panes: OpenChatPane[] = [
      { instanceId: "chat:a", channelId: "everyone", zIndex: 52 },
      { instanceId: "chat:b", channelId: "general", zIndex: 51 },
      { instanceId: "chat:c", channelId: "random", zIndex: 50 },
    ];

    test("the one already on the conversation wins", async () => {
      const result = await open(panes, { arg: "random", values: { messageId: "m1" } }, "chat:a");
      expect(result.focused).toEqual(["chat:c"]);
      expect(result.added).toEqual([]);
    });

    test("else the focused one, which switches over", async () => {
      const result = await open(panes, { arg: "dm:bob" }, "chat:b");
      expect(result.focused).toEqual(["chat:b"]);
      expect(result.settings("chat:b")).toEqual({ channelId: "dm:bob" });
      expect(result.settings("chat:a")).toEqual({ channelId: "everyone" });
    });

    test("else the one in front, when focus is on another kind of pane", async () => {
      const result = await open(panes, { arg: "dm:bob" }, "quote:main");
      expect(result.focused).toEqual(["chat:a"]);
      expect(result.settings("chat:a")).toEqual({ channelId: "dm:bob" });
    });
  });

  test("a new window opens only when none is open", async () => {
    const result = await open([], { arg: "general", values: { messageId: "m42" } });

    expect(result.focused).toEqual([]);
    expect(result.added).toEqual(["chat:general"]);
    expect(result.addedSettings).toEqual([{ channelId: "general", targetMessageId: "m42" }]);
  });
});
