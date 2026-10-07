import type { PluginCapability } from "../../../../capabilities";
import { teamAccentHex } from "./model";
import { teamStore, type TeamStoreSnapshot } from "./store";

const CLOUD_TEAM_CAPABILITY_ID = "cloud.team";

function publicSnapshot(snapshot: TeamStoreSnapshot) {
  return {
    teams: snapshot.teams,
    invitations: snapshot.invitations.map((invitation) => ({
      id: invitation.id,
      teamId: invitation.team.id,
      teamName: invitation.team.name,
      expiresAt: invitation.expiresAt,
    })),
    focus: snapshot.focus,
    defaultTeamId: teamStore.getDefaultTeamId(),
    loaded: snapshot.loaded,
  };
}

/**
 * What other plugins may know about teams. They consume this, never the
 * store, so the cloud plugin can change internals without touching them.
 */
export function createCloudTeamCapability(): PluginCapability {
  return {
    id: CLOUD_TEAM_CAPABILITY_ID,
    kind: "plugin-service",
    name: "Teams",
    operations: {
      list: {
        kind: "read",
        rendererSafe: true,
        handler: () => publicSnapshot(teamStore.getSnapshot()),
      },
      subscribe: {
        kind: "stream",
        rendererSafe: true,
        subscribe: (_input, emit) => {
          const publish = () => emit(publicSnapshot(teamStore.getSnapshot()));
          publish();
          return teamStore.subscribe(publish);
        },
      },
      members: {
        kind: "read",
        rendererSafe: true,
        handler: async (input: { teamId: string }) => {
          const { apiClient } = await import("../../../../api-client");
          return apiClient.getTeamMembers(input.teamId);
        },
      },
      invites: {
        kind: "read",
        rendererSafe: true,
        handler: () => publicSnapshot(teamStore.getSnapshot()).invitations,
      },
      accentColor: {
        kind: "read",
        rendererSafe: true,
        handler: (input: { teamId: string }) => {
          const team = teamStore.getTeam(input.teamId);
          return team
            ? { accent: team.accentColor, hex: teamAccentHex(team.accentColor), shortName: team.shortName }
            : null;
        },
      },
    },
  };
}
