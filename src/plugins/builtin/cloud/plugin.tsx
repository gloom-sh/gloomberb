import type { ComponentType, ReactNode } from "react";
import type { GloomPlugin, PaneProps } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";
import { AccountManagementPane } from "../account-management/pane";
import { BuildoutPane } from "../buildout/pane";
import { chatController } from "../chat/controller";
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
  CongressTradesPane,
} from "../congress-trades/pane";
import { registerTwitterFeedFeature } from "../cloud-tweets/registration";
import { composeBuiltinPlugin, type PluginModule } from "../plugin-module";
import { registerCloudAuthCommands } from "./auth-commands";
import { registerCloudUpgradeCommand } from "./upgrade-command";
import { CloudUpgradeStatusWidget } from "./upgrade-status-widget";

interface GloomberbCloudPluginComponents {
  ChatPane: (props: PaneProps) => ReactNode;
  ChatStatusWidget: ComponentType;
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
    }],
    paneTemplates: [{
      id: "new-chat-pane",
      paneId: "chat",
      label: "New Chat Pane",
      description: "Open another floating chat window",
      keywords: ["new", "chat", "pane", "message"],
      shortcut: { prefix: "CHAT", argPlaceholder: "channel", argKind: "text" },
      createInstance: async (context, options) => {
        const channelId = options?.arg
          ? await chatController.resolveRequiredChannelId(normalizeShortcutChannelId(options.arg))
          : await chatController.resolvePreferredChannelId(
            getPreferredChatOpenChannelId(context.config, chatController.getSnapshot()),
          );
        const channel = chatController.getChannels().find((entry) => entry.id === channelId);
        const targetMessageId = options?.values?.messageId?.trim() || null;
        return {
          placement: "floating",
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
      chatController.setNotifier(ctx.notify);
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
    "status:widget": () => <CloudUpgradeStatusWidget />,
  },
  setup: (ctx) => {
    registerCloudAuthCommands(ctx);
    registerCloudUpgradeCommand(ctx);
  },
};

const buildoutModule: PluginModule = {
  panes: [{
    id: "buildout",
    name: "TheBuildout",
    icon: "T",
    component: BuildoutPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 34 },
  }],
  paneTemplates: [{
    id: "buildout-pane",
    paneId: "buildout",
    label: "TheBuildout",
    description: "Open TheBuildout infrastructure intelligence.",
    keywords: ["tbo", "buildout", "thebuildout", "infrastructure", "sites", "intel"],
    shortcut: { prefix: "TBO" },
    createInstance: () => ({ placement: "floating" }),
  }],
};

const congressTradesModule: PluginModule = {
  panes: [{
    id: CONGRESS_TRADES_PANE_ID,
    name: "Congress",
    icon: "G",
    component: CongressTradesPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 112, height: 30 },
  }],
  paneTemplates: [{
    id: "congress-trades-pane",
    paneId: CONGRESS_TRADES_PANE_ID,
    label: "Congress Trades",
    description: "Track newly disclosed House periodic transaction reports.",
    keywords: ["congress", "house", "trades", "ptr", "stock", "disclosures"],
    shortcut: { prefix: "CG" },
    createInstance: () => ({ placement: "floating" }),
  }],
};

const twitterModule: PluginModule = {
  setup: registerTwitterFeedFeature,
};

export function createGloomberbCloudPlugin({
  ChatPane,
  ChatStatusWidget,
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
      accountModule,
      buildoutModule,
      congressTradesModule,
      twitterModule,
    ],
  });
}
