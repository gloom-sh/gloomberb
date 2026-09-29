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
import { chatController } from "./controller";
import { ChatPane } from "./pane";
import { chatSidebarStore } from "./sidebar-store";
import { ChatStatusWidget } from "./status-widget";

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
