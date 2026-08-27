import { act } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { apiClient, type AccountProfile, type ChatChannel, type ChatMessage } from "../../../api-client";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { setSharedMarketDataForTests, setSharedRegistryForTests } from "../../registry";
import { ChatContent } from "./content";
import { ChatController } from "./controller";

const TRANSCRIPT_KIND = "channel-transcript";
const TRANSCRIPT_KEY = "everyone";
const TRANSCRIPT_SOURCE = "server";
const TRANSCRIPT_SCHEMA_VERSION = 2;
const originalConnectChannel = apiClient.connectChannel.bind(apiClient);
const originalGetChannels = apiClient.getChannels.bind(apiClient);
const originalGetChatPresence = apiClient.getChatPresence.bind(apiClient);
const originalUpdateChatChannelState = apiClient.updateChatChannelState.bind(apiClient);
const originalEditMessage = apiClient.editMessage.bind(apiClient);

export type ChatTestSetup = Awaited<ReturnType<typeof testRender>>;

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

export async function cleanupChatTest(testSetup: ChatTestSetup | undefined): Promise<void> {
  setSharedRegistryForTests(undefined);
  setSharedMarketDataForTests(undefined);
  apiClient.connectChannel = originalConnectChannel;
  apiClient.getChannels = originalGetChannels;
  apiClient.getChatPresence = originalGetChatPresence;
  apiClient.updateChatChannelState = originalUpdateChatChannelState;
  apiClient.editMessage = originalEditMessage;
  apiClient.setSessionToken(null);

  if (testSetup) {
    await act(async () => {
      testSetup.renderer.destroy();
    });
  }
}

export function installServerChannels(controller: ChatController, channels = TEST_CHAT_CHANNELS): void {
  (controller as any).channelCatalog.channels = channels;
}

export { MemoryPluginPersistence as MemoryPersistence } from "../../../test-support/plugin-persistence";

export function makeAccountProfile(overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id: "u1",
    email: "vince@example.com",
    emailVerified: true,
    plan: "pro",
    username: "vince",
    name: "Vince",
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
  const user = Object.prototype.hasOwnProperty.call(options, "user")
    ? options.user ?? null
    : { id: "u0", username: "vince", emailVerified: true };
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
    />
  );

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PluginRenderProvider pluginId="gloomberb-cloud" runtime={options?.runtime ?? createTestPluginRuntime()}>
        {content}
      </PluginRenderProvider>
    </AppContext>
  );
}

export function createChatTestControls(getSetup: () => ChatTestSetup) {
  return {
    async flushFrame() {
      await act(async () => {
        await getSetup().renderOnce();
        await getSetup().renderOnce();
      });
    },
    async emitKeypress(event: {
      name?: string;
      sequence?: string;
      ctrl?: boolean;
      meta?: boolean;
      super?: boolean;
      alt?: boolean;
      shift?: boolean;
      option?: boolean;
    }) {
      const keyEvent = {
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
        eventType: "press",
        repeated: false,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
          keyEvent.defaultPrevented = true;
        },
        stopPropagation() {
          keyEvent.propagationStopped = true;
        },
        ...event,
      };
      await act(async () => {
        (getSetup().renderer.keyInput as any).emit("keypress", keyEvent);
        await getSetup().renderOnce();
      });
      return keyEvent;
    },
  };
}

export function lineText(line: { spans: Array<{ text: string }> }) {
  return line.spans.map((span) => span.text).join("");
}

export function hexToRgbaInts(hex: string) {
  const normalized = hex.replace("#", "");
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
    255,
  ].join(",");
}
