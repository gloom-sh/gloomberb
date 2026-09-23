import type { ComponentType, ReactNode } from "react";
import type { GloomPlugin, PaneProps } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";
import { AccountManagementPane } from "../account-management/pane";
import { chatController } from "../chat/controller";
import { chatSidebarStore } from "../chat/sidebar-store";
import {
  buildDmCommandResults,
  formatChatPaneTitle,
  getPreferredChatOpenChannelId,
  hasOnlyDmUsernameArgs,
  normalizeShortcutChannelId,
  openDmTargetFromCommand,
  parseDmUsernames,
} from "../chat/channels";
import {
  CONGRESS_TRADES_PANE_ID,
  CongressPane,
} from "../congress-trades/pane";
import { congressHeadless } from "../congress-trades/headless";
import { registerTwitterFeedFeature } from "../cloud-tweets/registration";
import { composeBuiltinPlugin, type PluginModule } from "../plugin-module";
import { askgConversationListStore } from "./askg/conversation-store";
import { ASKG_PANE_ID, ASKGPane } from "./askg/pane";
import { askGloomQuestion } from "./askg/pending-question";
import { registerCloudAuthCommands } from "./auth-commands";
import { registerCloudUpgradeCommand } from "./upgrade-command";
import { CloudUpgradeStatusWidget } from "./upgrade-status-widget";
import { CloudVerificationStatusWidget } from "./verification-status-widget";
import { createPublicPaneShare } from "../shared/public-pane";
import { teamChannelId } from "./team/model";
import { teamModule, teamStore } from "./team/module";
import { thesisModule } from "./thesis/module";

interface GloomberbCloudPluginComponents {
  ChatPane: (props: PaneProps) => ReactNode;
  ChatStatusWidget: ComponentType;
  extraModules?: readonly PluginModule[];
}

function createCloudDataModule(): PluginModule {
  return {
    capabilities: createGloomberbCloudCapabilities(createGloomberbCloudProvider()),
    setup(ctx) {
      ctx.registerSyncTransport({
        id: "gloomberb-cloud",
        isAvailable: () => apiClient.isVerified(),
        pullSnapshot: () => apiClient.getSyncSnapshot(),
        pushSnapshot: (snapshot, options) => apiClient.putSyncSnapshot(snapshot, options),
      });
    },
    dispose() {
      apiClient.dispose();
    },
  };
}

function createChatModule(
  ChatPane: GloomberbCloudPluginComponents["ChatPane"],
  ChatStatusWidget: GloomberbCloudPluginComponents["ChatStatusWidget"],
): PluginModule {
  return {
    panes: [{
      id: "chat",
      name: "Chat",
      icon: "C",
      component: ChatPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 80, height: 30 },
      portableShare: {
        private: { title: true, params: true, settings: true, state: true },
      },
    }],
    paneTemplates: [{
      id: "new-chat-pane",
      paneId: "chat",
      label: "New Chat Pane",
      description: "Open the floating chat window for a channel",
      keywords: ["new", "chat", "pane", "message"],
      shortcut: { prefix: "CHAT", argPlaceholder: "channel", argKind: "text" },
      createInstance: async (context, options) => {
        // `CHAT MD` or `CHAT "Macro Desk"` opens that team's #general. A raw
        // channel id (team ids are mixed case) is kept as typed.
        const rawArg = options?.arg?.trim() ?? "";
        const team = rawArg ? teamStore.findTeam(rawArg) : null;
        const channelId = team
          ? teamChannelId(team.id)
          : rawArg && chatController.getChannels().some((entry) => entry.id === rawArg)
          ? rawArg
          : rawArg
          ? await chatController.resolveRequiredChannelId(normalizeShortcutChannelId(rawArg))
          : await chatController.resolvePreferredChannelId(
            getPreferredChatOpenChannelId(context.config, chatController.getSnapshot()),
          );
        const channel = chatController.getChannels().find((entry) => entry.id === channelId);
        const targetMessageId = options?.values?.messageId?.trim() || null;
        return {
          placement: "floating",
          // One pane per channel: re-opening the same channel focuses the pane
          // that already holds it, even though its channelId setting drifts as
          // the user switches channels inside the pane. A jump to a specific
          // message stays unkeyed so it never lands on a pane that already
          // scrolled past the target.
          ...(targetMessageId ? {} : { instanceId: `chat:${channelId}` }),
          title: formatChatPaneTitle(channel, channelId),
          settings: {
            channelId,
            ...(targetMessageId ? { targetMessageId } : {}),
          },
        };
      },
    }],
    slots: {
      "status:widget": () => <ChatStatusWidget />,
    },
    setup(ctx) {
      chatController.attachPersistence(ctx.persistence, ctx.resume);
      chatSidebarStore.attach(ctx.persistence);
      chatController.setNotifier(ctx.notify, (channelId, messageId) => {
        ctx.createPaneFromTemplate("new-chat-pane", { arg: channelId, values: { messageId } });
      });
      ctx.registerCommand({
        id: "direct-message",
        label: "DM",
        description: "Open an existing DM or start a direct/group chat",
        keywords: ["dm", "direct", "message", "group", "chat"],
        category: "navigation",
        shortcut: "DM",
        shortcutArg: {
          placeholder: "@username [@username...]",
          kind: "text",
          parse: (arg) => ({ participants: arg.trim() }),
        },
        buildResults: (arg) => buildDmCommandResults(ctx, arg),
        execute: async (values) => {
          const participants = values?.participants ?? values?.shortcut ?? "";
          const usernames = parseDmUsernames(participants);
          if (participants.trim() && !hasOnlyDmUsernameArgs(participants)) {
            throw new Error("Use @username, or multiple usernames for a group chat.");
          }
          await openDmTargetFromCommand(ctx, usernames);
        },
      });
    },
    dispose() {
      chatController.dispose();
    },
  };
}

const accountModule: PluginModule = {
  panes: [{
    id: "account-management",
    name: "ACM",
    icon: "A",
    component: AccountManagementPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 72, height: 36 },
    portableShare: {
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: "account-management-pane",
    paneId: "account-management",
    label: "Account Management",
    description: "Edit your Gloom Cloud profile, password, and public portfolio sharing settings",
    keywords: ["account", "profile", "cloud", "acm", "password", "settings"],
    shortcut: { prefix: "ACM" },
    createInstance: () => ({ placement: "floating" }),
  }],
  slots: {
    "status:widget": () => (
      <>
        <CloudVerificationStatusWidget />
        <CloudUpgradeStatusWidget />
      </>
    ),
  },
  setup: (ctx) => {
    registerCloudAuthCommands(ctx);
    registerCloudUpgradeCommand(ctx);
  },
};

const askgModule: PluginModule = {
  setup(ctx) {
    // Only the dragged sidebar width is per device; the conversations
    // themselves belong to the account and are read from the cloud.
    askgConversationListStore.attach(ctx.persistence);
  },
  panes: [{
    id: ASKG_PANE_ID,
    name: "Ask Gloom",
    icon: "K",
    component: ASKGPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 96, height: 32 },
    portableShare: {
      // A conversation and the panes it read are personal to the account.
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: "askg-pane",
    paneId: ASKG_PANE_ID,
    label: "Ask Gloom",
    description: "Ask a question about your panes and watch the tools Gloom runs",
    keywords: ["ask", "gloom", "assistant", "ai", "question", "askg"],
    shortcut: { prefix: "ASKG", argPlaceholder: "question", argKind: "text" },
    createInstance: (_context, options) => {
      // The question is handed to the pane directly, so it is never persisted
      // with the layout and never replayed on the next launch.
      askGloomQuestion(options?.arg ?? "");
      // One assistant: a second question focuses the conversation already open
      // and asks there instead of stacking another pane.
      return { placement: "floating", instanceId: "askg:main" };
    },
  }],
};

const congressTradesModule: PluginModule = {
  panes: [{
    id: CONGRESS_TRADES_PANE_ID,
    name: "Congress",
    icon: "G",
    component: CongressPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 112, height: 30 },
    tableExport: true,
  }],
  paneTemplates: [{
    id: "congress-trades-pane",
    paneId: CONGRESS_TRADES_PANE_ID,
    label: "Congress Trades",
    description: "Track newly disclosed House and Senate periodic transaction reports.",
    keywords: ["congress", "house", "senate", "trades", "ptr", "stock", "disclosures"],
    shortcut: { prefix: "CG", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
    headless: congressHeadless,
    createInstance: (_context, options) => {
      const symbol = (options?.symbol ?? options?.arg)?.trim().toUpperCase();
      return symbol
        ? { instanceId: `${CONGRESS_TRADES_PANE_ID}:${symbol}`, title: `Congress ${symbol}`, placement: "floating", settings: { ticker: symbol } }
        : { placement: "floating" };
    },
    publicShare: createPublicPaneShare("Congress Trades"),
  }],
};

const twitterModule: PluginModule = {
  setup: registerTwitterFeedFeature,
};

export function createGloomberbCloudPlugin({
  ChatPane,
  ChatStatusWidget,
  extraModules = [],
}: GloomberbCloudPluginComponents): GloomPlugin {
  return composeBuiltinPlugin({
    id: "gloomberb-cloud",
    name: "Gloom Cloud",
    version: "1.0.0",
    description: "Free market, macro, and chat services. Chat requires signup.",
    toggleable: true,
    order: 10,
    modules: [
      createCloudDataModule(),
      createChatModule(ChatPane, ChatStatusWidget),
      teamModule,
      thesisModule,
      accountModule,
      askgModule,
      ...extraModules,
      congressTradesModule,
      twitterModule,
    ],
  });
}
