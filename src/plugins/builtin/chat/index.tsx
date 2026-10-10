import type { PluginModule } from "../plugin-module";
import { teamChannelId } from "../cloud/team/model";
import { teamStore } from "../cloud/team/store";
import { formatChatPaneTitle } from "./channel-labels";
import {
  buildDmCommandResults,
  getPreferredChatOpenChannelId,
  hasOnlyDmUsernameArgs,
  normalizeShortcutChannelId,
  openDmTargetFromCommand,
  parseDmUsernames,
} from "./channels";
import { CHAT_REUSE_PANE_VALUE, createChatSearchProvider } from "./command-bar";
import { chatController } from "./controller";
import { buildChatConversations, selectChatConversations } from "./conversations";
import { pickChatPaneToReuse } from "./pane-state";
import { ChatPane } from "./pane";
import { chatSidebarStore } from "./sidebar-store";
import { ChatStatusWidget } from "./status-widget";
import { UnreadInboxPane } from "./unread-inbox-pane";
import { UNREAD_INBOX_PANE_ID, UNREAD_INBOX_TEMPLATE_ID } from "./unread-inbox";

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

export const chatModule: PluginModule = {
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
  }, {
    id: UNREAD_INBOX_PANE_ID,
    reportFreshness: { status: "not-a-feed", basis: "chat messages" },
    name: "Unread",
    icon: "U",
    component: UnreadInboxPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 60, height: 16 },
  }],
  paneTemplates: [{
    id: "new-chat-pane",
    paneId: "chat",
    label: "New Chat Pane",
    description: "Open the floating chat window for a channel",
    keywords: ["new", "chat", "pane", "message"],
    shortcut: { prefix: "CHAT", argPlaceholder: "channel", argKind: "text" },
    createInstance: async (context, options) => {
      const reuse = options?.values?.[CHAT_REUSE_PANE_VALUE] === "1";
      const rawArg = options?.arg?.trim() ?? "";
      // The command bar's New DM keeps the open pane on its conversation.
      if (reuse && !rawArg) {
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
      // A conversation picked in the command bar goes to the Chat pane that is
      // open, which switches to it, rather than to a pane of its own.
      const open = reuse ? pickChatPaneToReuse(context.layout, context.focusedPaneId, channelId) : null;
      if (open) {
        return {
          placement: "floating",
          instanceId: open.instanceId,
          title: formatChatPaneTitle(channel, channelId),
          settings: { channelId },
        };
      }
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
  }, {
    id: UNREAD_INBOX_TEMPLATE_ID,
    paneId: UNREAD_INBOX_PANE_ID,
    label: "Unread Chat",
    description: "Open unread chat messages",
    keywords: ["unread", "chat", "inbox", "mentions"],
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
