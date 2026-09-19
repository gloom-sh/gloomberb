import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useCallback, useMemo, useRef, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createConfigBackedTestPluginRuntime, createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, findPaneInstance, type PaneInstanceConfig } from "../../../types/config";
import { TextAttributes } from "../../../ui";
import { apiClient } from "../../../api-client";
import { PluginRenderProvider } from "../../runtime";
import { gloomberbCloudPlugin } from "../cloud";
import { TeamStatusWidget } from "../cloud/team/status-widget";
import { teamStore } from "../cloud/team/store";
import { formatChatPaneTitle } from "./channel-labels";
import { ChatContent } from "./content";
import { chatController } from "./controller";
import { useChatChannelNavigation } from "./content/channel-navigation";
import {
  subscribeRequestedAccountManagementTab,
  type AccountManagementTab,
} from "../account-management/navigation";
import {
  cleanupChatTest,
  createChatTestControls,
  createController,
  createHarness,
  installChatApiTestDefaults,
  installServerChannels,
  lineText,
  makeAccountProfile,
  makeMessage,
  MemoryPersistence,
  type ChatTestSetup,
} from "./test-harness";

let testSetup: ChatTestSetup | undefined;
function setup(): ChatTestSetup {
  if (!testSetup) throw new Error("chat sidebar test setup is missing");
  return testSetup;
}
const { flushFrame, emitKeypress } = createChatTestControls(setup);

beforeEach(() => {
  installChatApiTestDefaults();
});

afterEach(async () => {
  await cleanupChatTest(testSetup);
  testSetup = undefined;
});

function createChannelPane(
  controller: ReturnType<typeof createController>,
  initialChannelId = "equities",
  onChannelChange?: (channelId: string) => void,
) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));

  return function ChannelPane() {
    const [channelId, setChannelId] = useState(initialChannelId);
    return (
      <AppContext value={{ state, dispatch: () => {} }}>
        <PluginRenderProvider pluginId="gloomberb-cloud" runtime={createTestPluginRuntime()}>
          <ChatContent
            controller={controller}
            width={90}
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
      <AppContext value={{ state, dispatch: () => {} }}>
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
      testSetup = await testRender(renderChannelPane(90), {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    expect(setup().captureCharFrame()).toContain("options");

    await act(async () => {
      testSetup?.renderer.destroy();
      testSetup = await testRender(renderChannelPane(60), {
        width: 60,
        height: 12,
      });
    });

    await flushFrame();
    expect(setup().captureCharFrame()).not.toContain("options");
  });

  test("selects a sidebar channel from a single text click", async () => {
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller);

    await act(async () => {
      testSetup = await testRender(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    expect(setup().captureCharFrame()).toContain("#equities");

    const lines = setup().captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("options"));
    const col = lines[row]?.indexOf("options") ?? -1;

    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await setup().mockMouse.click(col + 1, row);
      await setup().renderOnce();
      await setup().renderOnce();
    });
    await flushFrame();

    expect(setup().captureCharFrame()).toContain("#options");
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
      testSetup = await testRender(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    const unreadLine = setup().captureSpans().lines.find((line) => lineText(line).includes("options"));
    const unreadSpan = unreadLine?.spans.find((span) => span.text.includes("options"));
    expect((unreadSpan?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD);

    const lines = setup().captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("options"));
    const col = lines[row]?.indexOf("options") ?? -1;

    await act(async () => {
      await setup().mockMouse.click(col + 1, row);
      await setup().renderOnce();
      await setup().renderOnce();
    });
    await flushFrame();

    const readLine = setup().captureSpans().lines.find((line) => lineText(line).includes("#options"));
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
      testSetup = await testRender(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    const frame = setup().captureCharFrame();
    const lines = frame.split("\n");
    const row = lines.findIndex((line) => line.includes("options"));
    const col = lines[row]?.lastIndexOf("·") ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await setup().mockMouse.click(col, row);
      await setup().renderOnce();
      await setup().renderOnce();
    });
    await flushFrame();

    expect(toggles).toEqual([{ channelId: "options", enabled: true }]);
    expect(setup().captureCharFrame()).toContain("#equities");
    expect(setup().captureCharFrame()).not.toContain("#options");
  });

  test("folding the Channels header hides public channels and keeps arrows out of them", async () => {
    const controller = createController({
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
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
      testSetup = await testRender(<ChannelPane />, { width: 90, height: 14 });
    });
    await flushFrame();
    expect(setup().captureCharFrame()).toContain("▾ Channels");

    const lines = setup().captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Channels"));
    await act(async () => {
      await setup().mockMouse.click(2, row);
      await setup().renderOnce();
      await setup().renderOnce();
    });
    await flushFrame();

    const folded = setup().captureCharFrame();
    expect(folded).toContain("▸ Channels");
    expect(folded).not.toContain("equities");
    expect(folded).toContain("@bob");

    // Keyboard navigation walks the same list the sidebar draws, so arrows
    // must never land on a row inside a folded section.
    await emitKeypress({ name: "left", sequence: "[D" });
    await emitKeypress({ name: "down", sequence: "[B" });
    await emitKeypress({ name: "up", sequence: "[A" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await setup().renderOnce();
    });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((channelId) => channelId.startsWith("dm:"))).toBe(true);
  });

  test("opens a new direct-message dialog from the DMs header", async () => {
    const controller = createController({
      messages: [{
        ...makeMessage(1),
        user: { id: "u2", username: "bob", displayName: "Bob" },
      }],
      sessionToken: "token-123",
      user: { id: "u1", username: "vince", emailVerified: true },
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
        testSetup = await testRender(<ChannelPane />, {
          width: 90,
          height: 14,
        });
      });

      await flushFrame();
      const lines = setup().captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("DMs"));
      const col = lines[row]?.lastIndexOf("+") ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup().mockMouse.click(col, row);
        await setup().renderOnce();
        await setup().renderOnce();
      });
      await flushFrame();

      expect(setup().captureCharFrame()).toContain("New DM");

      await act(async () => {
        await setup().mockInput.typeText("@bob");
        setup().mockInput.pressEnter();
        await setup().renderOnce();
        await setup().renderOnce();
      });
      await flushFrame();

      expect(openedTargets).toEqual([{ username: "bob" }]);
      expect(selectedChannels).toEqual(["dm:bob"]);
      expect(setup().captureCharFrame()).toContain("@bob");
      expect(setup().captureCharFrame()).not.toContain("New DM");
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
      await act(async () => {
        testSetup = await testRender(createHarness(controller, { width: 90, height: 14, runtime }), {
          width: 90,
          height: 14,
        });
      });
      await flushFrame();
      await flushFrame();

      const lines = setup().captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("@ Profile"));
      const col = lines[row]?.indexOf("Profile") ?? -1;
      expect(row).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup().mockMouse.click(col + 1, row);
        await setup().renderOnce();
        await setup().renderOnce();
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
      await act(async () => {
        testSetup?.renderer.destroy();
        testSetup = await testRender(createHarness(controller, { width: 90, height: 14, runtime }), {
          width: 90,
          height: 14,
        });
      });
      await flushFrame();
      await flushFrame();

      expect(setup().captureCharFrame()).not.toContain("@ Profile");
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
      testSetup = await testRender(<ChannelPane />, {
        width: 90,
        height: 12,
      });
    });

    await flushFrame();
    expect(setup().captureCharFrame()).toContain("#equities");
    const getActiveChannelBackgrounds = () => {
      const activeLine = setup().captureSpans().lines.find((line) => lineText(line).includes("#equities"));
      expect(activeLine).toBeDefined();
      return activeLine!.spans.map((span) => span.bg.toInts().join(","));
    };
    const getContentBackgrounds = () => {
      const contentLine = setup().captureSpans().lines.find((line) => lineText(line).includes("No messages yet"));
      expect(contentLine).toBeDefined();
      return contentLine!.spans.map((span) => span.bg.toInts().join(","));
    };
    const contentFocusedBackgrounds = getActiveChannelBackgrounds();
    const rightFocusedBackgrounds = getContentBackgrounds();

    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    expect(setup().captureCharFrame()).toContain("#equities");

    await emitKeypress({ name: "left", sequence: "\u001b[D" });
    await flushFrame();
    expect(getActiveChannelBackgrounds()).not.toEqual(contentFocusedBackgrounds);
    expect(getContentBackgrounds()).not.toEqual(rightFocusedBackgrounds);
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await flushFrame();
    expect(setup().captureCharFrame()).toContain("#options");

    await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await flushFrame();
    expect(setup().captureCharFrame()).toContain("#equities");

    await emitKeypress({ name: "right", sequence: "\u001b[C" });
    await flushFrame();
    expect(getActiveChannelBackgrounds()).toEqual(contentFocusedBackgrounds);
    expect(getContentBackgrounds()).toEqual(rightFocusedBackgrounds);
    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await flushFrame();
    expect(setup().captureCharFrame()).toContain("#equities");
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
        showChannelSidebar: true,
      });
      latestCursorChannelId = navigation.sidebarCursorChannelId;
      latestCommittedChannelId = channelId;

      return null;
    }

    await act(async () => {
      testSetup = await testRender(<NavigationHarness />, {
        width: 90,
        height: 12,
      });
    });

    await act(async () => {
      navigation?.focusChannelSidebar();
      navigation?.moveSidebarChannelSelection("down");
      navigation?.moveSidebarChannelSelection("down");
      navigation?.moveSidebarChannelSelection("down");
      await setup().renderOnce();
    });

    expect(latestCursorChannelId).toBe("crypto");
    expect(latestCommittedChannelId).toBe("equities");
    expect(channelChanges).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
      await setup().renderOnce();
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
      testSetup = await testRender(
        <AppContext value={{ state, dispatch: () => {} }}>
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

    const frame = setup().captureCharFrame();
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
        <AppContext value={{ state, dispatch }}>
          <PaneInstanceProvider paneId={paneInstanceId}>
            <PluginRenderProvider pluginId="gloomberb-cloud" runtime={runtime}>
              <ResolvedChatPaneComponent
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
        testSetup = await testRender(<ChatPaneHarness />, {
          width: 90,
          height: 12,
        });
      });

      await flushFrame();
      const lines = setup().captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("options"));
      const col = lines[row]?.indexOf("options") ?? -1;

      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);

      await act(async () => {
        await setup().mockMouse.click(col + 1, row);
        await setup().renderOnce();
        await setup().renderOnce();
      });
      await flushFrame();

      expect(findPaneInstance(latestState.config.layout, paneInstanceId)?.settings?.channelId).toBe("options");
      expect(findPaneInstance(latestState.config.layout, paneInstanceId)?.title).toBe("#options");
      expect(latestState.config.pluginConfig["gloomberb-cloud"]?.lastChatChannelId).toBe("options");
      expect(setup().captureCharFrame()).toContain("#options");
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
  const macroDesk = {
    id: "org-1",
    name: "Macro Desk",
    slug: "macro-desk",
    accentColor: "magenta" as const,
    shortName: "MD",
    allowMemberInvites: false,
    channelId: "team:org-1",
    createdAt: "2026-09-14T12:00:00.000Z",
    role: "member" as const,
    memberCount: 3,
  };

  afterEach(() => {
    (teamStore as any).update({ teams: [] });
  });

  test("groups a team channel under its accent header with the short name prefix", async () => {
    (teamStore as any).update({ teams: [macroDesk] });
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      { id: "team:org-1", name: "general", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
    ]);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller, "everyone");

    await act(async () => {
      testSetup = await testRender(<ChannelPane />, { width: 90, height: 12 });
    });
    await flushFrame();

    const frame = setup().captureCharFrame();
    expect(frame).toContain("MD· Macro Desk");
    const lines = frame.split("\n");
    const header = lines.findIndex((line) => line.includes("MD· Macro Desk"));
    expect(header).toBeGreaterThan(-1);
    expect(lines[header + 1]).toContain("general");
    expect(lines.findIndex((line) => line.includes("everyone"))).toBeLessThan(header);
  });

  test("a team header folds its channels and offers a new-channel action", async () => {
    (teamStore as any).update({ teams: [macroDesk], collapsedTeams: new Set() });
    const controller = createController({ sessionToken: "token-123" });
    installServerChannels(controller, [
      { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
      { id: "team:org-1", name: "general", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
      { id: "team:org-1:trades", name: "trades", kind: "team", teamId: "org-1", created_at: "2026-09-14T12:00:00.000Z" },
    ]);
    controller.refreshChannels = async () => {};
    controller.refreshChannelMessages = async () => {};
    const ChannelPane = createChannelPane(controller, "everyone");

    await act(async () => {
      testSetup = await testRender(<ChannelPane />, { width: 90, height: 14 });
    });
    await flushFrame();
    let frame = setup().captureCharFrame();
    expect(frame).toMatch(/▾ MD· Macro Desk\s+\+ /);
    expect(frame).toContain("trades");

    await act(async () => {
      teamStore.toggleTeamCollapsed("org-1");
    });
    await flushFrame();
    frame = setup().captureCharFrame();
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
      testSetup = await testRender(<Chip />, { width: 40, height: 3 });
    });
    await flushFrame();
    expect(setup().captureCharFrame()).toContain("MD");
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
