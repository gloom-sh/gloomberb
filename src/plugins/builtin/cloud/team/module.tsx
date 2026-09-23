import type { PluginModule } from "../../plugin-module";
import { chatController } from "../../chat/controller";
import { createCloudTeamCapability } from "./capability";
import { registerTeamCommands } from "./command";
import { teamChannelId } from "./model";
import { TeamPane } from "./pane";
import { TEAM_PANE_ID, TEAM_PANE_TEMPLATE_ID, openTeamPane } from "./pane-request";
import { TeamStatusWidget } from "./status-widget";
import { teamStore } from "./store";
import { installTeamStateHost } from "./team-state-host";
import { createCloudViewsCapability, teamViewsStore } from "./views";

export { TeamsAccountTab } from "./acm-tab";
export { teamStore } from "./store";

/**
 * Teams inside the cloud plugin: the store every surface reads, the team pane
 * where a team is created and run, the `TEAM` and `FOCUS` commands, the
 * `cloud.team` capability for other plugins, and the accent chips in the
 * status bar.
 */
let disposeTeamState: (() => void) | null = null;
let disposeChannelRefresh: (() => void) | null = null;

export const teamModule: PluginModule = {
  capabilities: [createCloudTeamCapability(), createCloudViewsCapability()],
  panes: [{
    id: TEAM_PANE_ID,
    name: "Team",
    icon: "T",
    component: TeamPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 84, height: 30 },
    portableShare: {
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: TEAM_PANE_TEMPLATE_ID,
    paneId: TEAM_PANE_ID,
    label: "Team",
    description: "Members, invites, channels, and settings for your teams",
    keywords: ["team", "teams", "members", "invite", "collaborate"],
    createInstance: () => ({ placement: "floating", instanceId: "team" }),
  }],
  slots: {
    "status:widget": () => <TeamStatusWidget />,
  },
  setup(ctx) {
    teamStore.attach(ctx.persistence);
    teamStore.setNotifier(ctx.notify, {
      openTeamChannel: (teamId) => ctx.createPaneFromTemplate("new-chat-pane", { arg: teamChannelId(teamId) }),
      openTeamInvites: () => openTeamPane(ctx.createPaneFromTemplate, {}),
      openTeamLayout: () => {
        ctx.showPane("layout-marketplace");
      },
    });
    teamStore.start();
    registerTeamCommands(ctx);
    teamViewsStore.attach(ctx);
    teamViewsStore.start();
    disposeTeamState = installTeamStateHost();
    // The chat sidebar reads channels from the chat controller; when a team's
    // channels or membership change, that list is stale until refetched.
    disposeChannelRefresh = teamStore.onTeamUpdated((event) => {
      if (event.change !== "settings") void chatController.refreshChatState().catch(() => {});
    });
  },
  dispose() {
    disposeChannelRefresh?.();
    disposeChannelRefresh = null;
    teamViewsStore.dispose();
    disposeTeamState?.();
    disposeTeamState = null;
    teamStore.dispose();
  },
};
