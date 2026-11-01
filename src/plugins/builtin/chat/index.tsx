import type { PluginModule } from "../plugin-module";
import { teamChannelId } from "../../../team/model";
import { teamStore } from "../../../team/store";
import { formatChatPaneTitle } from "./channel-labels";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  LAST_VISITED_CHAT_CHANNEL_KEY,
  buildDmCommandResults,
  getPreferredChatOpenChannelId,
  hasOnlyDmUsernameArgs,
  normalizeShortcutChannelId,
  openDmTargetFromCommand,
  parseDmUsernames,
} from "./channels";
import { CHAT_KEEP_CONVERSATION_VALUE, createChatSearchProvider } from "./command-bar";
import { chatController } from "./controller";
import { buildChatConversations, selectChatConversations } from "./conversations";
import { pickChatPaneToReuse } from "./pane-state";
import { chatSidebarStore } from "./sidebar-store";
import { chatHandlePromptStore } from "./handle-prompt";
import { ChatStatusWidget } from "./status-widget";
import { installPaneChatSharing } from "./share/flow";
import { attachChatPaneLinkPanes } from "./pane-links/previews";
import { attachChatCommands, cachedChatFunctions, chatFunctionsChanged } from "./pane-links/commands";
import { getSharedRegistry } from "../../registry";
import { UNREAD_INBOX_PANE_ID, UNREAD_INBOX_TEMPLATE_ID } from "./unread-inbox";
import { watchUnreadBadge } from "./unread-badge";
import { getAppBadgeHost } from "../../../notifications/app-badge";
import { getNotificationLog, subscribeNotificationLog } from "../../../notifications/notification-log";

/**
 * `CHAT general` or `CHAT #help` by id; failing that, `CHAT gen` or `CHAT alice`
 * opens the conversation the command bar lists first for that text.
 */
async function resolveTypedChannelId(rawArg: string): Promise<string> {
  try {
    return await chatController.resolveRequiredChannelId(normalizeShortcutChannelId(rawArg));
  } catch (error) {
    const list = chatController.listConversations();
    const [best] = list
      ? selectChatConversations(buildChatConversations(list.states, list.userId), { kind: "search", text: rawArg })
      : [];
    if (best) return best.channelId;
    throw error;
  }
}

/** A DM, a group or a team channel: what only its members read. */
function isPrivateConversation(channelId: unknown): boolean {
  const id = typeof channelId === "string" && channelId.trim() ? channelId.trim() : DEFAULT_CHAT_CHANNEL_ID;
  const kind = chatController.getChannels().find((channel) => channel.id === id)?.kind;
  return kind ? kind !== "public" : /^(dm|grp|group|team):/.test(id);
}

let disposePaneChatSharing: (() => void) | undefined;
let detachPaneLinkPanes: (() => void) | undefined;
let detachCommands: (() => void) | undefined;
let disposeUnreadBadge: (() => void) | undefined;

export const chatModule: PluginModule = {
  panes: [{
    id: "chat",
    reportFreshness: { local: true },
    name: "Chat",
    icon: "C",
    get component(): typeof import("./pane").ChatPane { const { ChatPane } = require("./pane"); return ChatPane; },
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 80, height: 30 },
    // A pane with no channel yet opens the one last visited, a DM included.
    personalData: ({ settings, config }) => (
      isPrivateConversation(
        typeof settings.channelId === "string" ? settings.channelId : config.pluginConfig["gloomberb-cloud"]?.[LAST_VISITED_CHAT_CHANNEL_KEY],
      ) ? "messages" : null
    ),
    portableShare: {
      private: { title: true, params: true, settings: true, state: true },
    },
  }, {
    id: UNREAD_INBOX_PANE_ID,
    reportFreshness: { status: "not-a-feed", basis: "chat messages and missed alerts", local: true },
    name: "Unread",
    // Mentions and replies from every conversation, DMs included.
    personalData: "messages",
    icon: "U",
    get component(): typeof import("./unread-inbox-pane").UnreadInboxPane { const { UnreadInboxPane } = require("./unread-inbox-pane"); return UnreadInboxPane; },
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 88, height: 16 },
  }],
  paneTemplates: [{
    id: "new-chat-pane",
    paneId: "chat",
    label: "New Chat Pane",
    description: "Open the floating chat window for a channel",
    keywords: ["new", "chat", "pane", "message"],
    shortcut: { prefix: "CHAT", argPlaceholder: "channel", argKind: "text" },
    catalogSettings: {},
    createInstance: async (context, options) => {
      const rawArg = options?.arg?.trim() ?? "";
      // The command bar's New DM keeps the open pane on its conversation.
      if (!rawArg && options?.values?.[CHAT_KEEP_CONVERSATION_VALUE] === "1") {
        const open = pickChatPaneToReuse(context.layout, context.focusedPaneId, null);
        if (open) return { placement: "floating", instanceId: open.instanceId };
      }
      // `CHAT MD` or `CHAT "Macro Desk"` opens that team's #general. A raw
      // channel id (team ids are mixed case) is kept as typed.
      const team = rawArg ? teamStore.findTeam(rawArg) : null;
      const channelId = team
        ? teamChannelId(team.id)
        : rawArg && chatController.getChannels().some((entry) => entry.id === rawArg)
        ? rawArg
        : rawArg
        ? await resolveTypedChannelId(rawArg)
        : await chatController.resolvePreferredChannelId(
          getPreferredChatOpenChannelId(context.config, chatController.getSnapshot()),
        );
      const channel = chatController.getChannels().find((entry) => entry.id === channelId);
      const targetMessageId = options?.values?.messageId?.trim() || null;
      // However a conversation is opened (the command bar, a notification, the
      // unread list, a deep or share link), it shows in the Chat window that is
      // already open, switching it over and scrolling to the message when one is
      // named: the window on that conversation, else the focused one, else the
      // one in front. A pane's id names the channel it was first opened on, but
      // the user switches channels inside it, so the id cannot say which pane
      // holds a conversation. Only with no Chat window open does a new one open.
      const open = pickChatPaneToReuse(context.layout, context.focusedPaneId, channelId);
      return {
        placement: "floating",
        instanceId: open?.instanceId ?? `chat:${channelId}`,
        title: formatChatPaneTitle(channel, channelId),
        settings: {
          channelId,
          ...(targetMessageId ? { targetMessageId } : {}),
        },
      };
    },
  }, {
    id: UNREAD_INBOX_TEMPLATE_ID,
    paneId: UNREAD_INBOX_PANE_ID,
    label: "Unread",
    description: "Unread chat, then price alerts, catalysts, economic releases and team notices you missed",
    keywords: ["unread", "chat", "inbox", "mentions", "missed", "notifications", "alerts"],
    createInstance: () => ({
      placement: "floating",
      instanceId: "unread-inbox",
      title: "Unread",
    }),
  }],
  slots: {
    "status:widget": () => <ChatStatusWidget />,
  },
  setup(ctx) {
    ctx.registerCommandBarSearchProvider(createChatSearchProvider(ctx));
    disposePaneChatSharing?.();
    disposePaneChatSharing = installPaneChatSharing(ctx);
    // A chip names the pane it opens (any plugin's) and its letter.
    detachPaneLinkPanes?.();
    detachPaneLinkPanes = attachChatPaneLinkPanes((paneId) => ctx.getPaneDef(paneId));
    // A function written in a message is a chip for the codes this app runs, and runs in its command bar.
    detachCommands?.();
    detachCommands = attachChatCommands({
      functions: () => {
        const registry = getSharedRegistry();
        if (!registry) return cachedChatFunctions(null);
        const disabledPlugins = ctx.getConfig().disabledPlugins ?? [];
        return cachedChatFunctions({
          paneTemplates: registry.paneTemplates,
          commands: registry.commands,
          disabledPlugins,
          isTemplateOff: (templateId) => !!registry.getDisabledPaneTemplateOwner(templateId, disabledPlugins),
        });
      },
      run: (query) => getSharedRegistry()?.runCommandBarQuery(query),
    });
    // Messages drawn before a plugin came in, or with one since switched off, draw its codes again.
    for (const event of ["plugin:registered", "plugin:unregistered", "config:changed"] as const) ctx.on(event, chatFunctionsChanged);
    chatController.attachPersistence(ctx.persistence, ctx.resume);
    chatSidebarStore.attach(ctx.persistence);
    chatHandlePromptStore.attach(ctx.persistence);
    // The desktop app's Dock badge counts the people who wrote to you or tagged you, plus the missed notices; other hosts have no badge.
    disposeUnreadBadge?.();
    const badgeHost = getAppBadgeHost();
    disposeUnreadBadge = badgeHost
      ? watchUnreadBadge({
        controller: chatController,
        log: { get: getNotificationLog, subscribe: subscribeNotificationLog },
        setBadge: (label) => badgeHost.setBadge(label),
      })
      : undefined;
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
    disposePaneChatSharing?.();
    disposePaneChatSharing = undefined;
    detachPaneLinkPanes?.();
    detachPaneLinkPanes = undefined;
    detachCommands?.();
    detachCommands = undefined;
    // Before the controller drops its listeners, so the badge is cleared with the plugin.
    disposeUnreadBadge?.();
    disposeUnreadBadge = undefined;
    chatController.dispose();
  },
};
