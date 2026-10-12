import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ChatChannel } from "../../../api-client";
import { CommandBarHarness, createCommandBarTestControls } from "../../../components/command-bar/surface/test-harness";
import { updatePaneInstance } from "../../../pane-settings";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type LayoutConfig } from "../../../types/config";
import type { CommandBarSearchProvider, PaneTemplateContext, PaneTemplateCreateOptions, PaneTemplateDef } from "../../../types/plugin";
import { PluginRenderProvider } from "../../runtime";
import { buildDmCommandResults } from "./channels";
import {
  buildChatSearchRows,
  CHAT_REUSE_PANE_VALUE,
  createChatSearchProvider,
  openChatConversation,
  openChatNewDm,
} from "./command-bar";
import { ChatContent } from "./content";
import { chatController } from "./controller";
import type { ChatConversationList, ChatConversationState } from "./conversations";
import { chatModule } from "./index";
import { ChatPane } from "./pane";
import { createChatTestHarness, createController, installServerChannels, makeMessage } from "./test-harness";

const tui = createChatTestHarness();
const { flushFrame } = tui;
const { waitForFrameToContain, clickFrameText } = createCommandBarTestControls(() => tui.setup());

const SELF = { id: "u-self", username: "evalpro", displayName: "Eval Pro" };
const ALICE = { id: "u-alice", username: "asmith", displayName: "Alice Smith" };
const BOB = { id: "u-bob", username: "bob", displayName: "Bob" };
const GENA = { id: "u-gena", username: "gena", displayName: "Gena Park" };

function at(iso: string): number {
  return Date.parse(iso);
}

function conversation(channel: ChatChannel, lastActivityAt = Number.NEGATIVE_INFINITY, unreadCount = 0): ChatConversationState {
  return { channel, unreadCount, lastActivityAt };
}

const created = "2026-09-01T00:00:00.000Z";
const everyone: ChatChannel = { id: "everyone", name: "everyone", kind: "public", created_at: created };
const general: ChatChannel = { id: "general", name: "general", kind: "public", created_at: created };
const product: ChatChannel = { id: "product", name: "product", kind: "public", created_at: created };
const dmAlice: ChatChannel = { id: "dm:alice", name: "@asmith", kind: "direct", created_at: created, dmUser: ALICE };
const dmBob: ChatChannel = { id: "dm:bob", name: "@bob", kind: "direct", created_at: created, dmUser: BOB };
const dmGena: ChatChannel = { id: "dm:gena", name: "@gena", kind: "direct", created_at: created, dmUser: GENA };
const desk: ChatChannel = {
  id: "grp:desk",
  name: "Macro desk",
  kind: "group",
  created_at: created,
  members: [SELF, ALICE, BOB],
};

/** Two unread (a DM and a channel), DMs at different ages, a group, and read channels. */
function signedIn(): ChatConversationList {
  return {
    userId: SELF.id,
    states: [
      conversation(everyone, at("2026-10-09T13:00:00Z")),
      conversation(general, at("2026-10-09T09:00:00Z")),
      conversation(product, at("2026-10-09T10:00:00Z"), 3),
      conversation(dmAlice, at("2026-10-08T00:00:00Z")),
      conversation(dmBob, at("2026-10-09T08:00:00Z")),
      conversation(dmGena, at("2026-10-09T12:00:00Z"), 2),
      conversation(desk, at("2026-10-05T00:00:00Z")),
    ],
  };
}

function rows(query: string, list: ChatConversationList | null = signedIn()) {
  return buildChatSearchRows({ createPaneFromTemplate: () => {} }, query, { listConversations: () => list });
}

function labels(query: string, list?: ChatConversationList | null) {
  return rows(query, list).map((row) => row.label);
}

describe("chat rows in the command bar", () => {
  test("find a channel by part of its name and a person by username or full name", () => {
    expect(labels("prod")).toEqual(["#product"]);
    expect(labels("#gen")).toEqual(["@gena", "#general"]);
    // Alice by her name: her DM, then the group she is in.
    expect(labels("alice")).toEqual(["@asmith", "Macro desk"]);
    expect(labels("asm")).toEqual(["@asmith", "Macro desk"]);

    const [alice] = rows("alice smith");
    expect(alice).toMatchObject({ label: "@asmith", name: "Alice Smith", badge: "DM", right: "" });
    expect(rows("product")[0]).toMatchObject({ badge: "CHAT", right: "3 unread" });
    expect(rows("desk")[0]).toMatchObject({ badge: "GROUP", name: "@asmith, @bob" });
  });

  test("short text puts unread conversations first, longer text the closest name", () => {
    // "ge" is too short to say much: the unread DM leads.
    expect(labels("ge")).toEqual(["@gena", "#general"]);
    // "general" is the channel's name, so it leads even though @gena is unread.
    expect(labels("general")).toEqual(["#general"]);
    expect(labels("b")).toEqual(["@bob", "Macro desk"]);
  });

  test("the empty bar shows a few: unread first, then the latest DMs, and no read channels", () => {
    expect(labels("")).toEqual(["@gena", "#product", "@bob", "@asmith"]);
    // With nothing of either on this device, the one with more unread leads.
    expect(labels("", {
      userId: SELF.id,
      states: [conversation(general, Number.NEGATIVE_INFINITY, 1), conversation(product, Number.NEGATIVE_INFINITY, 3)],
    })).toEqual(["#product", "#general"]);
  });

  test("'messages' and 'chat' list every conversation and end with New DM; 'chat gen' searches", () => {
    expect(labels("messages")).toEqual([
      "@gena",
      "#product",
      "@bob",
      "@asmith",
      "Macro desk",
      "#everyone",
      "#general",
      "New DM",
    ]);
    expect(labels("chat")).toEqual(labels("messages"));
    expect(labels("chat gen")).toEqual(labels("gen"));
  });

  test("signed out or unverified there are no rows, not even New DM", () => {
    for (const query of ["", "gen", "messages", "chat"]) {
      expect(rows(query, null)).toEqual([]);
    }
  });

  test("picking a row asks for its composer and puts it in the open Chat pane", async () => {
    const opened: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    const [row] = buildChatSearchRows(
      { createPaneFromTemplate: (templateId, options) => { opened.push({ templateId, options }); } },
      "bob",
      { listConversations: signedIn },
    );
    await row!.execute();
    expect(opened).toEqual([{
      templateId: "new-chat-pane",
      options: { arg: "dm:bob", values: { [CHAT_REUSE_PANE_VALUE]: "1" } },
    }]);
  });
});

describe("the conversations the chat controller lists", () => {
  test("only for a verified account, with the unread counts and messages this device holds", () => {
    const signedOut = createController({ user: null });
    installServerChannels(signedOut, [everyone, dmBob]);
    expect(signedOut.listConversations()).toBeNull();
    const unverified = createController({ user: { id: SELF.id, username: SELF.username, emailVerified: false } });
    installServerChannels(unverified, [everyone, dmBob]);
    expect(unverified.listConversations()).toBeNull();

    const latest = makeMessage(7);
    const controller = createController({
      messages: [makeMessage(6), latest],
      sessionToken: "token-123",
      user: { id: SELF.id, username: SELF.username, emailVerified: true },
    });
    installServerChannels(controller, [everyone, dmBob]);
    // Loading the chat state readies a runtime state for every channel it lists.
    controller.getSnapshot("everyone");
    (controller as any).storage.ensureChannelState("dm:bob").unreadCount = 2;

    expect(controller.listConversations()?.states.map((state) => [
      state.channel.id,
      state.unreadCount,
      state.lastActivityAt,
    ])).toEqual([
      ["everyone", 0, Date.parse(latest.createdAt)],
      // Nothing of the DM on this device yet: it counts from when it started.
      ["dm:bob", 2, Date.parse(created)],
    ]);
  });
});

describe("DM in the command bar", () => {
  function withConversations<T>(list: ChatConversationList | null, run: () => T): T {
    chatController.listConversations = () => list;
    try {
      return run();
    } finally {
      delete (chatController as any).listConversations;
    }
  }
  const ctx = { createPaneFromTemplate: () => {} } as never;

  test("lists DMs and groups, unread first, and ends with New DM", () => {
    const results = withConversations(signedIn(), () => buildDmCommandResults(ctx, ""));
    expect(results.map((result) => result.label)).toEqual(["@gena", "@bob", "@asmith", "Macro desk", "New DM"]);
    expect(results.every((result) => result.category === "Chat")).toBe(true);
  });

  test("a name you already share a DM with leads with that DM instead of starting one", () => {
    const shared = withConversations(signedIn(), () => buildDmCommandResults(ctx, "@asmith"));
    expect(shared.map((result) => result.label)).toEqual(["@asmith", "Macro desk"]);

    const someoneNew = withConversations(signedIn(), () => buildDmCommandResults(ctx, "@al"));
    // Alice is found by her name, and @al may be someone else entirely.
    expect(someoneNew.map((result) => result.label)).toEqual(["@asmith", "Macro desk", "DM @al"]);
  });
});

describe("opening a conversation from the command bar", () => {
  function chatPane(controller: ReturnType<typeof createController>, initialChannelId: string, expose: (set: (id: string) => void) => void) {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    return function ChatPaneProbe() {
      const [channelId, setChannelId] = useState(initialChannelId);
      expose(setChannelId);
      return (
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
            <ChatContent
              controller={controller}
              width={90}
              height={12}
              focused
              channelId={channelId}
              onChannelChange={setChannelId}
            />
          </PluginRenderProvider>
        </AppContext>
      );
    };
  }

  async function mountOn(channelId: string) {
    const controller = createController({ sessionToken: "token-123", user: { id: SELF.id, username: SELF.username, emailVerified: true } });
    installServerChannels(controller, [everyone, general, dmBob]);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    let setChannel: (id: string) => void = () => {};
    const Pane = chatPane(controller, channelId, (set) => { setChannel = set; });
    await act(async () => {
      await tui.render(<Pane />, { width: 90, height: 12 });
    });
    await flushFrame();
    // What the host does with the template: the open pane switches to the conversation.
    const host = {
      createPaneFromTemplate: (_templateId: string, options?: PaneTemplateCreateOptions) => {
        if (options?.arg) setChannel(options.arg);
      },
    };
    return host;
  }

  async function typeIntoComposer(text: string): Promise<void> {
    await act(async () => {
      await tui.setup().mockInput.typeText(text);
      await tui.setup().renderOnce();
    });
    await flushFrame();
  }

  test("the open Chat pane switches to it with the composer ready", async () => {
    const host = await mountOn("everyone");
    // A switch nobody asked a composer for leaves the keys with the transcript.
    await act(async () => {
      host.createPaneFromTemplate("new-chat-pane", { arg: "general" });
    });
    await flushFrame();
    await typeIntoComposer("hi");
    expect(tui.frame()).not.toContain("> hi");

    await act(async () => {
      openChatConversation(host, "dm:bob");
    });
    await flushFrame();
    await typeIntoComposer("yo");

    expect(tui.frame()).toContain("> yo");
    expect(tui.frame()).toContain("@bob");
  });

  test("New DM opens the pane's own dialog", async () => {
    const host = await mountOn("everyone");
    await act(async () => {
      openChatNewDm(host);
    });
    await flushFrame();

    expect(tui.frame()).toContain("New DM");
  });

  test("the Chat template reuses the open pane, the one on the conversation first", async () => {
    const template = chatModule.paneTemplates!.find((entry) => entry.id === "new-chat-pane") as PaneTemplateDef;
    const original = (chatController as any).channelCatalog.channels;
    (chatController as any).channelCatalog.channels = [everyone, general, dmBob];
    const layout = (instances: Array<[string, string, number]>): LayoutConfig => ({
      dockRoot: null,
      instances: instances.map(([instanceId, channelId]) => ({ instanceId, paneId: "chat", settings: { channelId } })),
      floating: instances.map(([instanceId, , zIndex]) => ({ instanceId, x: 0, y: 0, width: 80, height: 30, zIndex })),
      detached: [],
    });
    const context = (paneLayout: LayoutConfig, focusedPaneId: string | null = null) => ({
      layout: paneLayout,
      focusedPaneId,
      activeTicker: null,
      activeCollectionId: null,
    }) as unknown as PaneTemplateContext;
    const reuse = { arg: "dm:bob", values: { [CHAT_REUSE_PANE_VALUE]: "1" } };
    try {
      // The frontmost Chat pane switches over.
      expect(await template.createInstance!(context(layout([["chat:everyone", "everyone", 51], ["chat:general", "general", 52]])), reuse))
        .toMatchObject({ instanceId: "chat:general", settings: { channelId: "dm:bob" }, title: "@bob" });
      // A pane already on it wins.
      expect(await template.createInstance!(context(layout([["chat:everyone", "everyone", 52], ["chat:x", "dm:bob", 51]])), reuse))
        .toMatchObject({ instanceId: "chat:x" });
      // No Chat pane: a pane of its own.
      expect(await template.createInstance!(context(layout([])), reuse))
        .toMatchObject({ instanceId: "chat:dm:bob", settings: { channelId: "dm:bob" } });
      // Typed CHAT keeps one pane per channel.
      expect(await template.createInstance!(context(layout([["chat:everyone", "everyone", 51]])), { arg: "dm:bob" }))
        .toMatchObject({ instanceId: "chat:dm:bob" });
      // `CHAT gen` is no channel id; it opens what the bar lists first for "gen".
      chatController.resolveRequiredChannelId = async (channelId) => {
        throw new Error(`Unknown chat channel "#${channelId}".`);
      };
      chatController.listConversations = signedIn;
      expect(await template.createInstance!(context(layout([])), { arg: "prod" }))
        .toMatchObject({ settings: { channelId: "product" } });
      expect(await template.createInstance!(context(layout([])), { arg: "alice" }))
        .toMatchObject({ settings: { channelId: "dm:alice" } });
    } finally {
      (chatController as any).channelCatalog.channels = original;
      delete (chatController as any).resolveRequiredChannelId;
      delete (chatController as any).listConversations;
    }
  });
});

describe("a Chat pane switched from outside", () => {
  test("takes the new conversation in the render that focuses it, so the old one is not marked read", async () => {
    const attached: Array<[string, boolean]> = [];
    chatController.attachChannelView = (channelId: string, focused = true) => {
      attached.push([channelId, focused]);
      return () => {};
    };
    chatController.refreshChannels = async () => {};
    chatController.refreshSession = async () => {};
    chatController.refreshPresence = async () => {};
    chatController.refreshChannelMessages = async () => {};
    const paneId = "chat:x";
    const base = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    const layout: LayoutConfig = {
      dockRoot: { kind: "pane", instanceId: paneId },
      floating: [],
      detached: [],
      instances: [{ instanceId: paneId, paneId: "chat", settings: { channelId: "everyone" } }],
    };
    const initial = { ...base, config: { ...base.config, layout, layouts: [{ name: "Test", layout }] } };
    let switchFromOutside: () => void = () => {};

    function Harness() {
      const [state, setState] = useState(initial);
      const [focused, setFocused] = useState(false);
      // What the command bar does: the pane's channel and the focus change together.
      switchFromOutside = () => {
        setState((current) => ({
          ...current,
          config: {
            ...current.config,
            layout: updatePaneInstance(current.config.layout, paneId, (instance) => ({
              ...instance,
              settings: { ...instance.settings, channelId: "dm:bob" },
            })),
          },
        }));
        setFocused(true);
      };
      return (
        <AppContext value={createStaticAppStore(state)}>
          <PaneInstanceProvider paneId={paneId}>
            <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
              <ChatPane paneId={paneId} paneType="chat" width={90} height={12} focused={focused} />
            </PluginRenderProvider>
          </PaneInstanceProvider>
        </AppContext>
      );
    }

    try {
      await act(async () => {
        await tui.render(<Harness />, { width: 90, height: 12 });
      });
      await flushFrame();
      await act(async () => {
        switchFromOutside();
      });
      await flushFrame();

      expect(attached).toContainEqual(["dm:bob", true]);
      expect(attached).not.toContainEqual(["everyone", true]);
    } finally {
      for (const key of ["attachChannelView", "refreshChannels", "refreshSession", "refreshPresence", "refreshChannelMessages"]) {
        delete (chatController as any)[key];
      }
    }
  });
});

describe("the command bar with chat rows", () => {
  function chatProvider(onOpen: (options?: PaneTemplateCreateOptions) => void): CommandBarSearchProvider {
    return createChatSearchProvider(
      { createPaneFromTemplate: (_templateId, options) => onOpen(options) },
      { listConversations: signedIn },
    );
  }

  async function renderBar(provider: CommandBarSearchProvider) {
    await tui.render(<CommandBarHarness
      query=""
      live
      configurePluginRegistry={(pluginRegistry) => {
        (pluginRegistry.commandBarSearchProviders as Map<string, CommandBarSearchProvider>).set(provider.id, provider);
      }}
    />, { width: 110, height: 30 });
    await tui.setup().renderOnce();
  }

  async function type(text: string): Promise<void> {
    await act(async () => {
      await tui.setup().mockInput.typeText(text);
      await tui.setup().renderOnce();
    });
  }

  test("draws channels and DMs under one Chat heading, tagged, with unread counts, and opens the one picked", async () => {
    const opened: Array<PaneTemplateCreateOptions | undefined> = [];
    await renderBar(chatProvider((options) => opened.push(options)));

    // The empty bar: unread first.
    const empty = await waitForFrameToContain("2 unread");
    expect(empty).toMatch(/Chat\s*\n\s*DM @gena\s+Gena Park\s+2 unread/);
    expect(empty).toMatch(/CHAT #product\s+3 unread/);

    await type("gen");
    const frame = await waitForFrameToContain("#general");
    expect(frame).toMatch(/DM @gena\s+Gena Park\s+2 unread/);
    expect(frame).toMatch(/CHAT #general/);
    expect(frame).not.toContain("#product");

    // Enter runs the first row, the unread DM.
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });
    expect(opened.map((options) => options?.arg)).toEqual(["dm:gena"]);
  });

  test("a click opens the row under the mouse", async () => {
    const opened: Array<PaneTemplateCreateOptions | undefined> = [];
    await renderBar(chatProvider((options) => opened.push(options)));
    await type("gen");
    await waitForFrameToContain("#general");

    await clickFrameText("#general");
    await act(async () => {
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });
    expect(opened.map((options) => options?.arg)).toEqual(["general"]);
  });
});
