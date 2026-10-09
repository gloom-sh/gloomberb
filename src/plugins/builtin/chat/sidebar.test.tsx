import { afterEach, describe, expect, test } from "bun:test";
import { act, useCallback, useMemo, useRef, useState } from "react";
import { AppContext, appReducer, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createConfigBackedTestPluginRuntime, createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, findPaneInstance, type PaneInstanceConfig } from "../../../types/config";
import { TextAttributes } from "../../../ui";
import { apiClient } from "../../../api-client";
import { PluginRenderProvider } from "../../runtime";
import { gloomberbCloudPlugin } from "../cloud";
import { TeamStatusWidget } from "../cloud/team/status-widget";
import { teamStore } from "../cloud/team/store";
import { createTestTeam } from "../cloud/team/test-fixture";
import { formatChatPaneTitle } from "./channel-labels";
import { ChatContent } from "./content";
import { chatController } from "./controller";
import { useChatChannelNavigation } from "./content/channel-navigation";
import {
  subscribeRequestedAccountManagementTab,
  type AccountManagementTab,
} from "../account-management/navigation";
import {
  createChatTestHarness,
  createController,
  installServerChannels,
  lineText,
  makeAccountProfile,
  makeMessage,
  MemoryPersistence,
} from "./test-harness";

const tui = createChatTestHarness();
const { flushFrame, emitKeypress, mountChat } = tui;

function createChannelPane(
  controller: ReturnType<typeof createController>,
  initialChannelId = "equities",
  onChannelChange?: (channelId: string) => void,
  width = 90,
  /** Receives the pane's channel setter, to switch it from outside the view. */
  exposeSetChannel?: (setChannel: (channelId: string) => void) => void,
) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));

  return function ChannelPane() {
    const [channelId, setChannelId] = useState(initialChannelId);
    exposeSetChannel?.(setChannelId);
    return (
      <AppContext value={createStaticAppStore(state)}>
        <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <ChatContent
            controller={controller}
            width={width}
            height={12}
            focused
            channelId={channelId}
            onChannelChange={(nextChannelId) => {
              onChannelChange?.(nextChannelId);
              setChannelId(nextChannelId);
            }}
          />
        </PluginRenderProvider>
      </AppContext>
    );
  };
}

describe("ChatContent channel sidebar", () => {
  test("shows the channel sidebar on wide panes and hides it on narrow panes", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};

    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    const renderChannelPane = (width: number) => (
      <AppContext value={createStaticAppStore(state)}>
        <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <ChatContent
            controller={controller}
            width={width}
            height={12}
            focused
            channelId="options"
            onChannelChange={() => {}}
          />
        </PluginRenderProvider>
      </AppContext>
    );

    await act(async () => {
      await tui.render(renderChannelPane(90), {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    expect(tui.frame()).toContain("options");

    await act(async () => {
      await tui.render(renderChannelPane(60), {
        width: 60,
        height: 12,
      });
    });

    await flushFrame();
    expect(tui.frame()).not.toContain("options");
  });

  test("a narrow pane stacks the list behind the open channel, by key and by mouse", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    (controller as any).ensureChannelState("macro").unreadCount = 2;
    const changes: string[] = [];
    let setChannelFromOutside: ((channelId: string) => void) | null = null;
    const ChannelPane = createChannelPane(controller, "options", (channelId) => changes.push(channelId), 60, (setChannel) => {
      setChannelFromOutside = setChannel;
    });

    await act(async () => {
      await tui.render(<ChannelPane />, { width: 60, height: 12 });
    });
    await flushFrame();
    // The pane title names the channel, so the stack row is only Back.
    expect(tui.frame()).toContain("← Back");
    expect(tui.frame()).not.toContain("#options");
    expect(tui.frame()).not.toContain("equities");

    const back = await emitKeypress({ name: "escape", sequence: "\u001b" });
    expect(back.propagationStopped).toBe(true);
    await flushFrame();
    expect(tui.frame()).not.toContain("← Back");
    expect(tui.frame()).toContain("equities");

    // Passing over a channel in the list neither opens it nor reads it.
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flushFrame();
    expect(tui.frame()).not.toContain("← Back");
    expect((controller as any).ensureChannelState("macro").unreadCount).toBe(2);

    await emitKeypress({ name: "return", sequence: "\r" });
    await flushFrame();
    expect(tui.frame()).toContain("← Back");
    expect(changes.at(-1)).toBe("macro");
    expect((controller as any).ensureChannelState("macro").unreadCount).toBe(0);

    await tui.clickFrameText("← Back");
    await flushFrame();
    expect(tui.frame()).not.toContain("← Back");
    await tui.clickFrameText("everyone");
    await flushFrame();
    expect(tui.frame()).toContain("← Back");
    expect(changes.at(-1)).toBe("everyone");

    // A channel opened from elsewhere (the unread list, a notification) is shown, not the list.
    await emitKeypress({ name: "escape", sequence: "\u001b" });
    await flushFrame();
    expect(tui.frame()).not.toContain("← Back");
    await act(async () => {
      setChannelFromOutside?.("crypto");
    });
    await flushFrame();
    expect(tui.frame()).toContain("← Back");
  });

  test("selects a sidebar channel from a single text click", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller);

    await act(async () => {
      await tui.render(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    expect(tui.frame()).toContain("#equities");

    const lines = tui.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("options"));
    const col = lines[row]?.indexOf("options") ?? -1;

    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(col + 1, row);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    expect(tui.frame()).toContain("#options");
  });

  test("renders unread sidebar channels in bold and clears them when opened", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const optionsState = (controller as any).ensureChannelState("options");
    optionsState.unreadCount = 2;
    const ChannelPane = createChannelPane(controller);

    await act(async () => {
      await tui.render(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    const unreadLine = tui.setup().captureSpans().lines.find((line) => lineText(line).includes("options"));
    const unreadSpan = unreadLine?.spans.find((span) => span.text.includes("options"));
    expect((unreadSpan?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);

    const lines = tui.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("options"));
    const col = lines[row]?.indexOf("options") ?? -1;

    await act(async () => {
      await tui.setup().mockMouse.click(col + 1, row);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    const readLine = tui.setup().captureSpans().lines.find((line) => lineText(line).includes("#options"));
    const readSpan = readLine?.spans.find((span) => span.text.includes("options"));
    expect((readSpan?.attributes ?? 0) & TextAttributes.BOLD).toBe(0);
  });

  test("toggles sidebar channel notifications without selecting the channel", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const toggles: Array<{ channelId: string; enabled: boolean }> = [];
    controller.setChannelNotificationsEnabled = (channelId: string, enabled: boolean) => {
      toggles.push({ channelId, enabled });
    };
    const ChannelPane = createChannelPane(controller);

    await act(async () => {
      await tui.render(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    const frame = tui.frame();
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("options"));
    const col = lines[row]?.lastIndexOf("·") ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(col, row);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    expect(toggles).toEqual([{ channelId: "options", enabled: true }]);
    expect(tui.frame()).toContain("#equities");
    expect(tui.frame()).not.toContain("#options");
  });

  test("folding the Channels header hides public channels and keeps arrows out of them", async () => {
    const controller = createController({
      sessionToken: "token-123",
      user: { id: "u1", username: "ada", emailVerified: true },
    });
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      { id: "equities", name: "equities", created_at: "2026-05-09T00:00:00.000Z" },
      { id: "dm:bob", name: "@bob", kind: "direct", dmUser: { id: "u2", username: "bob" }, created_at: "2026-05-09T00:00:00.000Z" },
      { id: "dm:carol", name: "@carol", kind: "direct", dmUser: { id: "u3", username: "carol" }, created_at: "2026-05-09T00:00:00.000Z" },
    ] as any);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const selected: string[] = [];
    const ChannelPane = createChannelPane(controller, "everyone", (channelId) => selected.push(channelId));

    await act(async () => {
      await tui.render(<ChannelPane />, { width: 90, height: 14 });
    });
    await flushFrame();
    expect(tui.frame()).toContain("▾ Channels");

    const lines = tui.frame().split("\n");
    const row = lines.findIndex((line) => line.includes("Channels"));
    await act(async () => {
      await tui.setup().mockMouse.click(2, row);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    const folded = tui.frame();
    expect(folded).toContain("▸ Channels");
    expect(folded).not.toContain("equities");
    expect(folded).toContain("@bob");

    // Keyboard navigation walks the same list the sidebar draws, headers
    // included, so arrows must never land on a row inside a folded section.
    // The open channel is folded away, so the cursor starts on its header.
    await emitKeypress({ name: "left", sequence: "\u001b[D" });
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await emitKeypress({ name: "j", sequence: "j" });
    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tui.setup().renderOnce();
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((channelId) => channelId.startsWith("dm:"))).toBe(true);

    // Back up to the folded header, where Enter unfolds it in place.
    await emitKeypress({ name: "k", sequence: "k" });
    await emitKeypress({ name: "return", sequence: "\r" });
    await flushFrame();
    const unfolded = tui.frame();
    expect(unfolded).toContain("▾ Channels");
    expect(unfolded).toContain("equities");
    expect(selected.every((channelId) => channelId.startsWith("dm:"))).toBe(true);
  });

  test("opens a new direct-message dialog from the DMs header", async () => {
    const controller = createController({
      messages: [{
        ...makeMessage(1),
        user: { id: "u2", username: "bob", displayName: "Bob" },
      }],
      sessionToken: "token-123",
      user: { id: "u1", username: "ada", emailVerified: true },
    });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const openedTargets: Array<{ username?: string }> = [];
    const originalOpenDirectChannel = apiClient.openDirectChannel.bind(apiClient);
    apiClient.openDirectChannel = async (target) => {
      openedTargets.push(target);
      return {
        id: "dm:bob",
        name: "@bob",
        kind: "direct",
        created_at: "2026-07-03T09:30:00.000Z",
        dmUser: { id: "u2", username: "bob", displayName: "Bob" },
      };
    };
    const selectedChannels: string[] = [];
    const ChannelPane = createChannelPane(controller, "everyone", (channelId) => {
      selectedChannels.push(channelId);
    });

    try {
      await act(async () => {
        await tui.render(<ChannelPane />, {
          width: 90,
          height: 14,
        });
      });

      await flushFrame();
      const lines = tui.frame().split("\n");
      const row = lines.findIndex((line) => line.includes("DMs"));
      const col = lines[row]?.lastIndexOf("+") ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await tui.setup().mockMouse.click(col, row);
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });
      await flushFrame();

      expect(tui.frame()).toContain("New DM");

      await act(async () => {
        await tui.setup().mockInput.typeText("@bob");
        tui.setup().mockInput.pressEnter();
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });
      await flushFrame();

      expect(openedTargets).toEqual([{ username: "bob" }]);
      expect(selectedChannels).toEqual(["dm:bob"]);
      expect(tui.frame()).toContain("@bob");
      expect(tui.frame()).not.toContain("New DM");
    } finally {
      apiClient.openDirectChannel = originalOpenDirectChannel;
    }
  });

  test("the Message action on the card of someone with no public profile starts the DM, selects it and leaves the composer ready", async () => {
    const juniper = {
      id: "u-juniper",
      username: "juniper",
      displayName: "Juniper Park",
      profilePublic: false,
      acceptUnknownDms: true,
    };
    const controller = createController({
      messages: [{ ...makeMessage(1), user: juniper }],
      sessionToken: "token-123",
      user: { id: "u1", username: "ada", emailVerified: true },
    });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const openedTargets: Array<{ username?: string }> = [];
    const originalOpenDirectChannel = apiClient.openDirectChannel.bind(apiClient);
    apiClient.openDirectChannel = async (target) => {
      openedTargets.push(target);
      return { id: "dm:juniper", name: "@juniper", kind: "direct", created_at: "2026-07-03T09:30:00.000Z", dmUser: juniper };
    };
    const selectedChannels: string[] = [];
    const ChannelPane = createChannelPane(controller, "everyone", (channelId) => {
      selectedChannels.push(channelId);
    });

    try {
      await act(async () => {
        await tui.render(<ChannelPane />, { width: 90, height: 14 });
      });
      await flushFrame();
      await tui.clickFrameText("juniper");
      await flushFrame();
      await tui.clickFrameText("Message");
      await flushFrame();

      expect(openedTargets).toEqual([{ username: "juniper" }]);
      expect(selectedChannels).toEqual(["dm:juniper"]);
      await act(async () => {
        await tui.setup().mockInput.typeText("hi");
        await tui.setup().renderOnce();
      });
      await flushFrame();
      expect(tui.frame()).toContain("> hi");
    } finally {
      apiClient.openDirectChannel = originalOpenDirectChannel;
    }
  });

  test("offers a sidebar profile shortcut only until the account profile is filled in", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const originalGetAccountProfile = apiClient.getAccountProfile.bind(apiClient);
    apiClient.getAccountProfile = async () => makeAccountProfile({
      id: "u0",
      company: null,
      title: null,
      bio: null,
      publicEmail: null,
      xAccount: null,
      // Set, and deliberately not part of the completion test.
      profilePublic: true,
      sharedPortfolioId: null,
    });
    const requestedTabs: AccountManagementTab[] = [];
    const unsubscribe = subscribeRequestedAccountManagementTab((tab) => requestedTabs.push(tab));
    const shownPanes: string[] = [];
    const runtime = createTestPluginRuntime({
      showPane: (paneId: string) => {
        shownPanes.push(paneId);
      },
    });

    try {
      await mountChat(controller, { width: 90, height: 14, runtime });
      await flushFrame();

      const lines = tui.frame().split("\n");
      const row = lines.findIndex((line) => line.includes("@ Profile"));
      const col = lines[row]?.indexOf("Profile") ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await tui.setup().mockMouse.click(col + 1, row);
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });
      await flushFrame();

      expect(requestedTabs).toEqual(["profile"]);
      expect(shownPanes).toEqual(["account-management"]);

      apiClient.getAccountProfile = async () => makeAccountProfile({
        id: "u0",
        company: null,
        title: "Trader",
        bio: null,
        profilePublic: false,
        sharedPortfolioId: null,
      });
      await mountChat(controller, { width: 90, height: 14, runtime });
      await flushFrame();

      expect(tui.frame()).not.toContain("@ Profile");
    } finally {
      unsubscribe();
      apiClient.getAccountProfile = originalGetAccountProfile;
    }
  });

  test("uses arrows to move between channel sidebar and chat content", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller);

    await act(async () => {
      await tui.render(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    expect(tui.frame()).toContain("#equities");
    const getActiveChannelBackgrounds = () => {
      const activeLine = tui.setup().captureSpans().lines.find((line) => lineText(line).includes("#equities"));
      expect(activeLine).toBeDefined();
      return activeLine!.spans.map((span) => span.bg.toInts().join(","));
    };
    const getContentBackgrounds = () => {
      const contentLine = tui.setup().captureSpans().lines.find((line) => lineText(line).includes("No messages yet"));
      expect(contentLine).toBeDefined();
      return contentLine!.spans.map((span) => span.bg.toInts().join(","));
    };
    const contentFocusedBackgrounds = getActiveChannelBackgrounds();
    const rightFocusedBackgrounds = getContentBackgrounds();

    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    expect(tui.frame()).toContain("#equities");

    await emitKeypress({ name: "left", sequence: "\u001b[D" });
    await flushFrame();
    expect(getActiveChannelBackgrounds()).not.toEqual(contentFocusedBackgrounds);
    expect(getContentBackgrounds()).not.toEqual(rightFocusedBackgrounds);
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await flushFrame();
    expect(tui.frame()).toContain("#options");

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();
    expect(tui.frame()).toContain("#equities");

    await emitKeypress({ name: "right", sequence: "\u001b[C" });
    await flushFrame();
    expect(getActiveChannelBackgrounds()).toEqual(contentFocusedBackgrounds);
    expect(getContentBackgrounds()).toEqual(rightFocusedBackgrounds);
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await flushFrame();
    expect(tui.frame()).toContain("#equities");
  });

  test("coalesces rapid sidebar navigation to the final channel", async () => {
    const channels = [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      { id: "equities", name: "equities", created_at: "2026-05-09T00:00:00.000Z" },
      { id: "options", name: "options", created_at: "2026-05-09T00:00:00.000Z" },
      { id: "macro", name: "macro", created_at: "2026-05-09T00:00:00.000Z" },
      { id: "crypto", name: "crypto", created_at: "2026-05-09T00:00:00.000Z" },
    ];
    const channelChanges: string[] = [];
    let navigation: ReturnType<typeof useChatChannelNavigation> | null = null;
    let latestCursorChannelId = "";
    let latestCommittedChannelId = "";

    function NavigationHarness() {
      const [channelId, setChannelId] = useState("equities");
      const channelIdRef = useRef(channelId);
      channelIdRef.current = channelId;
      const handleChannelChange = useCallback((nextChannelId: string) => {
        channelChanges.push(nextChannelId);
        setChannelId(nextChannelId);
      }, []);
      navigation = useChatChannelNavigation({
        blurInput: () => {},
        channelId,
        channelIdRef,
        channels,
        channelsLoading: false,
        focused: true,
        inputFocused: false,
        onChannelChange: handleChannelChange,
        resetTranscriptSelection: () => {},
        channelListVisible: true,
      });
      latestCursorChannelId = navigation.sidebarCursorChannelId;
      latestCommittedChannelId = channelId;

      return null;
    }

    await act(async () => {
      await tui.render(<NavigationHarness />, {
        width: 90,
        height: 12,
      });
    });

    await act(async () => {
      navigation?.focusChannelSidebar();
      navigation?.moveSidebarChannelSelection("down");
      navigation?.moveSidebarChannelSelection("down");
      navigation?.moveSidebarChannelSelection("down");
      await tui.setup().renderOnce();
    });

    expect(latestCursorChannelId).toBe("crypto");
    expect(latestCommittedChannelId).toBe("equities");
    expect(channelChanges).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      await tui.setup().renderOnce();
    });

    expect(channelChanges).toEqual(["crypto"]);
    expect(latestCommittedChannelId).toBe("crypto");
  });

  test("keeps the channel sidebar visible while a channel loads", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    const getSnapshot = controller.getSnapshot.bind(controller);
    controller.getSnapshot = ((channelId?: string) => ({
      ...getSnapshot(channelId),
      loading: true,
      messages: [],
    })) as typeof controller.getSnapshot;
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};

    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));

    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(state)}>
          <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
            <ChatContent
              controller={controller}
              width={90}
              height={12}
              focused
              channelId="options"
              onChannelChange={() => {}}
            />
          </PluginRenderProvider>
        </AppContext>,
        {
          width: 90,
          height: 12,
        },
      );
    });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("#options");
    expect(frame).toContain("Loading...");
  });

  test("persists a pane channel selection without the last-visited write reverting it", async () => {
    await gloomberbCloudPlugin.setup!({
      persistence: new MemoryPersistence(),
      resume: {
        getState: () => null,
        setState: () => {},
        deleteState: () => {},
      },
      registerPane: () => {},
      registerPaneTemplate: () => {},
      registerTickerResearchTab: () => {},
      registerSyncTransport: () => {},
      registerShortcut: () => {},
      registerCommand: () => {},
      showPane: () => {},
      hidePane: () => {},
      notify: () => {},
      log: { error: () => {} },
    } as any);
    const ChatPaneComponent = gloomberbCloudPlugin.panes?.find((pane) => pane.id === "chat")?.component;
    expect(ChatPaneComponent).toBeDefined();
    const ResolvedChatPaneComponent = ChatPaneComponent!;

    const originalRefreshChannels = chatController.refreshChannels;
    const originalRefreshSession = chatController.refreshSession;
    const originalRefreshChannelMessages = chatController.refreshChannelMessages;
    installServerChannels(chatController);
    chatController.refreshChannels = async () => {};
    chatController.refreshSession = async () => {};
    chatController.refreshChannelMessages = async () => {};

    const paneInstanceId = "chat:test";
    const chatInstance: PaneInstanceConfig = {
      instanceId: paneInstanceId,
      paneId: "chat",
      settings: { channelId: "equities" },
    };
    const layout = {
      dockRoot: { kind: "pane" as const, instanceId: paneInstanceId },
      floating: [],
      detached: [],
      instances: [chatInstance],
    };
    const initialState = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
    initialState.focusedPaneId = paneInstanceId;
    initialState.config = {
      ...initialState.config,
      layout,
      layouts: [{ name: "Test", layout }],
      pluginConfig: {
        "gloomberb-cloud": {
          lastChatChannelId: "equities",
        },
      },
    };
    let latestState = initialState;

    function ChatPaneHarness() {
      const [state, setState] = useState(initialState);
      const stateRef = useRef(state);
      stateRef.current = state;
      latestState = state;
      const dispatch = useCallback((action: any) => {
        setState((current) => {
          const next = appReducer(current, action);
          latestState = next;
          return next;
        });
      }, []);
      const runtime = useMemo(() => createConfigBackedTestPluginRuntime({
        getConfig: () => stateRef.current.config,
        setConfig: (config) => dispatch({ type: "SET_CONFIG", config }),
      }), [dispatch]);

      return (
        <AppContext value={createStaticAppStore(state, dispatch)}>
          <PaneInstanceProvider paneId={paneInstanceId}>
            <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
              <ResolvedChatPaneComponent
                paneId={paneInstanceId}
                paneType="chat"
                width={90}
                height={12}
                focused
                close={() => {}}
              />
            </PluginRenderProvider>
          </PaneInstanceProvider>
        </AppContext>
      );
    }

    try {
      await act(async () => {
        await tui.render(<ChatPaneHarness />, {
          width: 90,
          height: 12,
        });
      });

      await flushFrame();
      const lines = tui.frame().split("\n");
      const row = lines.findIndex((line) => line.includes("options"));
      const col = lines[row]?.indexOf("options") ?? -1;

      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await tui.setup().mockMouse.click(col + 1, row);
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });
      await flushFrame();

      expect(findPaneInstance(latestState.config.layout, paneInstanceId)?.settings?.channelId).toBe("options");
      expect(findPaneInstance(latestState.config.layout, paneInstanceId)?.title).toBe("#options");
      expect(latestState.config.pluginConfig["gloomberb-cloud"]?.lastChatChannelId).toBe("options");
      expect(tui.frame()).toContain("#options");
    } finally {
      chatController.refreshChannels = originalRefreshChannels;
      chatController.refreshSession = originalRefreshSession;
      chatController.refreshChannelMessages = originalRefreshChannelMessages;
      installServerChannels(chatController, []);
      chatController.dispose();
    }
  });
});

describe("team channels in the sidebar", () => {
  const macroDesk = createTestTeam();

  afterEach(() => {
    (teamStore as any).update({ teams: [] });
  });

  test("groups a team channel under its accent header with the short name prefix", async () => {
    const controller = createController({ sessionToken: "token-123" });
    // Teams arrive after the account is restored; credential changes clear
    // state belonging to the previous account.
    (teamStore as any).update({ teams: [macroDesk] });
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      { id: "team:org-1", name: "general", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
    ]);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller, "everyone");

    await act(async () => {
      await tui.render(<ChannelPane />, { width: 90, height: 12 });
    });
    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("MD· Macro Desk");
    const lines = frame.split("\n");
    const header = lines.findIndex((line) => line.includes("MD· Macro Desk"));
    expect(header).toBeGreaterThan(-1);
    expect(lines[header + 1]).toContain("general");
    expect(lines.findIndex((line) => line.includes("everyone"))).toBeLessThan(header);
  });

  test("a team header folds its channels and offers a new-channel action", async () => {
    const controller = createController({ sessionToken: "token-123" });
    (teamStore as any).update({ teams: [macroDesk], collapsedTeams: new Set() });
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      { id: "team:org-1", name: "general", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
      { id: "team:org-1:trades", name: "trades", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
    ]);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller, "everyone");

    await act(async () => {
      await tui.render(<ChannelPane />, { width: 90, height: 14 });
    });
    await flushFrame();
    let frame = tui.frame();
    expect(frame).toMatch(/▾ MD· Macro Desk\s+\+ /);
    expect(frame).toContain("trades");

    await act(async () => {
      teamStore.toggleTeamCollapsed("org-1");
    });
    await flushFrame();
    frame = tui.frame();
    expect(frame).toContain("▸ MD· Macro Desk");
    expect(frame).not.toContain("trades");
    (teamStore as any).update({ collapsedTeams: new Set() });
  });

  test("the status chip mounts against the live chat controller and shows unread", async () => {
    // chatController.getSnapshot() builds a fresh object per call; the chip
    // must not feed it to useSyncExternalStore or React loops at startup.
    (teamStore as any).update({ teams: [macroDesk] });
    const previousChannelStates = chatController.getSnapshot().channelStates;
    function Chip() {
      return (
        <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <TeamStatusWidget />
        </PluginRenderProvider>
      );
    }
    await act(async () => {
      await tui.render(<Chip />, { width: 40, height: 3 });
    });
    await flushFrame();
    expect(tui.frame()).toContain("MD");
    expect(chatController.getSnapshot().channelStates).toEqual(previousChannelStates);
  });

  test("pane titles carry the team prefix", () => {
    (teamStore as any).update({ teams: [macroDesk] });
    expect(formatChatPaneTitle(
      { id: "team:org-1", name: "general", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
      "team:org-1",
    )).toBe("MD·#general");
    expect(formatChatPaneTitle(undefined, "team:org-1")).toBe("MD·#general");
    expect(formatChatPaneTitle({ id: "equities", name: "equities", created_at: "x" }, "equities")).toBe("#equities");
  });
});
