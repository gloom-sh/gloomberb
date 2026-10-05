import { afterEach, beforeEach } from "bun:test";
import { act } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { parseHex } from "../../../theme/color-utils";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { apiClient, type AccountProfile, type ChatChannel, type ChatMessage } from "../../../api-client";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { setSharedMarketDataForTests, setSharedRegistryForTests } from "../../registry";
import { ChatContent } from "./content";
import { ChatController } from "./controller";
import { chatSidebarStore } from "./sidebar-store";

const TRANSCRIPT_KIND = "channel-transcript";
const TRANSCRIPT_KEY = "everyone";
const TRANSCRIPT_SOURCE = "server";
const TRANSCRIPT_SCHEMA_VERSION = 2;
const originalConnectChannel = apiClient.connectChannel.bind(apiClient);
const originalGetChannels = apiClient.getChannels.bind(apiClient);
const originalGetChatPresence = apiClient.getChatPresence.bind(apiClient);
const originalUpdateChatChannelState = apiClient.updateChatChannelState.bind(apiClient);
const originalEditMessage = apiClient.editMessage.bind(apiClient);
const testControllers = new Set<ChatController>();

const TEST_CHAT_CHANNELS: ChatChannel[] = [
  { id: "everyone", name: "everyone", created_at: "2026-03-26T12:10:05.684Z" },
  { id: "equities", name: "equities", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "options", name: "options", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "macro", name: "macro", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "crypto", name: "crypto", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "energy", name: "energy", created_at: "2026-05-09T00:00:00.000Z" },
  { id: "help", name: "help", created_at: "2026-05-09T00:00:00.000Z" },
];

export function installChatApiTestDefaults(): void {
  apiClient.getChatPresence = async () => ({ onlineCount: 0 });
  apiClient.updateChatChannelState = async (channelId, body) => ({
    channelId,
    notificationsEnabled: body.notificationsEnabled ?? false,
    lastReadMessageId: body.readThroughMessageId ?? null,
    unreadCount: 0,
  });
}

export function cleanupChatTest(): void {
  // Unmounting the view does not dispose its separately owned controller.
  // Release every fixture's channels and timers before restoring shared APIs.
  for (const controller of testControllers) controller.dispose();
  testControllers.clear();

  // The sidebar's width and folded sections are a process-wide singleton.
  chatSidebarStore.reset();
  setSharedRegistryForTests(undefined);
  setSharedMarketDataForTests(undefined);
  apiClient.connectChannel = originalConnectChannel;
  apiClient.getChannels = originalGetChannels;
  apiClient.getChatPresence = originalGetChatPresence;
  apiClient.updateChatChannelState = originalUpdateChatChannelState;
  apiClient.editMessage = originalEditMessage;
  apiClient.setSessionToken(null);
}

export function installServerChannels(controller: ChatController, channels = TEST_CHAT_CHANNELS): void {
  (controller as any).channelCatalog.channels = channels;
}

export { MemoryPluginPersistence as MemoryPersistence } from "../../../test-support/plugin-persistence";

export function makeAccountProfile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id: "u1",
    email: "ada@example.com",
    emailVerified: true,
    plan: "pro",
    username: "ada",
    name: "Ada",
    company: "Gloom",
    title: null,
    bio: "Made Gloomberb",
    profilePublic: true,
    publicEmail: null,
    xAccount: null,
    sharedPortfolioId: "broker:ibkr:coldstart",
    acceptUnknownDms: false,
    chatEmailNotificationsEnabled: true,
    portfolioAnalytics: null,
    syncEnabled: true,
    weeklyRoundupEnabled: true,
    positionAlertsEnabled: true,
    lastSyncAt: null,
    lastRoundupEmailAt: null,
    updatedAt: "2026-07-21T22:03:59.832Z",
    ...overrides,
  };
}

export function makeMessage(index: number): ChatMessage {
  return {
    id: `m${index}`,
    channelId: "everyone",
    content: `message ${index}`,
    replyToId: null,
    createdAt: `2026-03-30T00:00:${String(index).padStart(2, "0")}.000Z`,
    user: {
      id: `u${index}`,
      username: `user${index}`,
      displayName: `User ${index}`,
    },
  };
}

export function createController(options: {
  messages?: ChatMessage[];
  sessionToken?: string | null;
  user?: { id: string; username: string; emailVerified: boolean } | null;
  replyToId?: string | null;
} = {}) {
  const messages = options.messages ?? [];
  const persistence = new MemoryPluginPersistence();
  const controller = new ChatController();
  testControllers.add(controller);
  const user = Object.prototype.hasOwnProperty.call(options, "user")
    ? options.user ?? null
    : { id: "u0", username: "ada", emailVerified: true };
  persistence.setState("session", {
    sessionToken: options.sessionToken ?? null,
    user,
  }, { schemaVersion: 1 });
  persistence.setState("channel:everyone", {
    draft: "",
    replyToId: options.replyToId ?? null,
    lastCursor: messages[messages.length - 1]?.id ?? null,
  }, { schemaVersion: 1 });
  if (messages.length > 0) {
    persistence.setResource(TRANSCRIPT_KIND, TRANSCRIPT_KEY, { messages }, {
      sourceKey: TRANSCRIPT_SOURCE,
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      cachePolicy: { staleMs: 1_000, expireMs: 2_000 },
    });
  }
  controller.attachPersistence(persistence);
  controller.refreshSession = async () => {};
  controller.refreshMessages = async () => {};
  controller.refreshPresence = async () => {};
  controller.refreshChatState = async () => {};
  return controller;
}

export function createHarness(
  controller: ChatController,
  options?: {
    width?: number;
    height?: number;
    configureState?: (state: ReturnType<typeof createInitialState>) => void;
    withFooter?: boolean;
    runtime?: PluginRuntimeAccess;
    targetMessageId?: string;
    onTargetMessageHandled?: () => void;
    /** Lets the view switch channels, which a pane with a channel list needs. */
    onChannelChange?: (channelId: string) => void;
  },
) {
  const width = options?.width ?? 60;
  const height = options?.height ?? 12;
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-chat"));
  options?.configureState?.(state);

  const content = options?.withFooter ? (
    <PaneFooterProvider>
      {(footer) => (
        <Box flexDirection="column" width={width} height={height}>
          <ChatContent
            controller={controller}
            width={width}
            height={Math.max(1, height - 1)}
            focused
            targetMessageId={options?.targetMessageId}
            onTargetMessageHandled={options?.onTargetMessageHandled}
            onChannelChange={options?.onChannelChange}
          />
          <PaneFooterBar footer={footer} focused width={width} />
        </Box>
      )}
    </PaneFooterProvider>
  ) : (
    <ChatContent
      controller={controller}
      width={width}
      height={height}
      focused
      targetMessageId={options?.targetMessageId}
      onTargetMessageHandled={options?.onTargetMessageHandled}
      onChannelChange={options?.onChannelChange}
    />
  );

  return (
    <AppContext value={createStaticAppStore(state)}>
      <PluginRenderProvider pluginId="gloomberb-cloud" runtime={options?.runtime ?? createTestPluginRuntime()}>
        {content}
      </PluginRenderProvider>
    </AppContext>
  );
}

/**
 * The OpenTUI harness for a chat suite. Around every test it installs the
 * chat API defaults, and afterwards it tears the renderer down and then
 * releases the fixture controllers and shared chat state.
 */
export function createChatTestHarness() {
  const tui = createOpenTuiTestHarness();
  beforeEach(installChatApiTestDefaults);
  afterEach(cleanupChatTest);

  const flushFrame = async (): Promise<void> => {
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
  };

  return {
    ...tui,
    flushFrame,
    emitKeypress: (event: TestKeyEvent) => tui.emitKeypress(event, { trackPropagation: true }),
    /** Renders the chat view at the renderer's size and settles its first frames. */
    async mountChat(controller: ChatController, options: Parameters<typeof createHarness>[1] = {}): Promise<void> {
      const width = options.width ?? 60;
      const height = options.height ?? 12;
      await act(async () => {
        await tui.render(createHarness(controller, { ...options, width, height }), { width, height });
      });
      await flushFrame();
    },
  };
}

export function lineText(line: { spans: Array<{ text: string }> }) {
  return line.spans.map((span) => span.text).join("");
}

export function hexToRgbaInts(hex: string) {
  return [...parseHex(hex), 255].join(",");
}
