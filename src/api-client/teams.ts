import { normalizeTeamNotification } from "./normalizers";
import type { CloudApiSocket } from "./socket";
import type {
  ChatChannel,
  TeamAccentColor,
  TeamInviteLink,
  TeamMember,
  TeamNotification,
  TeamReceivedInvitation,
  TeamRole,
  TeamSentInvitation,
  TeamSummary,
  TeamUpdatedEvent,
  TeamUsernameInvitation,
} from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;
type TeamNotificationListener = (notification: TeamNotification) => void;
type CloudEventListener = (data: unknown) => void;

interface CloudTeamsApiOptions {
  request: CloudApiRequest;
  socket: CloudApiSocket;
}

export class CloudTeamsApi {
  constructor(private readonly options: CloudTeamsApiOptions) {}

  async listTeams(): Promise<TeamSummary[]> {
    const body = await this.options.request<{ teams: TeamSummary[] }>("/teams");
    return body.teams;
  }

  async createTeam(input: {
    name: string;
    accentColor?: TeamAccentColor;
    shortName?: string;
  }): Promise<TeamSummary> {
    return this.options.request<TeamSummary>("/teams", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getTeamMembers(
    teamId: string,
  ): Promise<{ team: TeamSummary; members: TeamMember[] }> {
    return this.options.request<{ team: TeamSummary; members: TeamMember[] }>(
      `/teams/${encodeURIComponent(teamId)}/members`,
    );
  }

  async inviteTeamMemberByUsername(
    teamId: string,
    username: string,
  ): Promise<TeamUsernameInvitation> {
    return this.options.request<TeamUsernameInvitation>(
      `/teams/${encodeURIComponent(teamId)}/invitations`,
      {
        method: "POST",
        body: JSON.stringify({ username }),
      },
    );
  }

  async listTeamInviteLinks(teamId: string): Promise<TeamInviteLink[]> {
    const body = await this.options.request<{ links: TeamInviteLink[] }>(
      `/teams/${encodeURIComponent(teamId)}/invite-links`,
    );
    return body.links;
  }

  async createTeamInviteLink(
    teamId: string,
    options?: { expiresInDays?: number; maxUses?: number | null },
  ): Promise<TeamInviteLink> {
    return this.options.request<TeamInviteLink>(
      `/teams/${encodeURIComponent(teamId)}/invite-links`,
      {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      },
    );
  }

  async deleteTeamInviteLink(teamId: string, token: string): Promise<void> {
    await this.options.request<void>(
      `/teams/${encodeURIComponent(teamId)}/invite-links/${encodeURIComponent(token)}`,
      { method: "DELETE" },
    );
  }

  async getTeamNotifications(): Promise<TeamNotification[]> {
    const body = await this.options.request<{
      notifications: TeamNotification[];
    }>("/teams/notifications");
    return body.notifications.map((notification) =>
      normalizeTeamNotification(notification),
    );
  }

  async listTeamInvitations(teamId: string): Promise<TeamSentInvitation[]> {
    const body = await this.options.request<{ invitations: TeamSentInvitation[] }>(
      `/teams/${encodeURIComponent(teamId)}/invitations`,
    );
    return body.invitations;
  }

  async listMyTeamInvitations(): Promise<TeamReceivedInvitation[]> {
    const body = await this.options.request<{ invitations: TeamReceivedInvitation[] }>(
      "/teams/invitations",
    );
    return body.invitations;
  }

  async acceptTeamInvitation(invitationId: string): Promise<TeamSummary> {
    return this.options.request<TeamSummary>(
      `/teams/invitations/${encodeURIComponent(invitationId)}/accept`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async rejectTeamInvitation(invitationId: string): Promise<void> {
    await this.options.request<void>(
      `/teams/invitations/${encodeURIComponent(invitationId)}/reject`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async cancelTeamInvitation(teamId: string, invitationId: string): Promise<void> {
    await this.options.request<void>(
      `/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  }

  async updateTeam(
    teamId: string,
    data: {
      name?: string;
      accentColor?: TeamAccentColor;
      shortName?: string;
      allowMemberInvites?: boolean;
    },
  ): Promise<TeamSummary> {
    return this.options.request<TeamSummary>(`/teams/${encodeURIComponent(teamId)}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async updateTeamMemberRole(
    teamId: string,
    memberId: string,
    role: TeamRole,
  ): Promise<TeamMember[]> {
    const body = await this.options.request<{ members: TeamMember[] }>(
      `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
    return body.members;
  }

  async removeTeamMember(teamId: string, memberId: string): Promise<TeamMember[]> {
    const body = await this.options.request<{ members: TeamMember[] }>(
      `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    );
    return body.members;
  }

  async leaveTeam(teamId: string): Promise<void> {
    await this.options.request<void>(`/teams/${encodeURIComponent(teamId)}/leave`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.options.request<void>(`/teams/${encodeURIComponent(teamId)}`, {
      method: "DELETE",
    });
  }

  async createTeamChannel(teamId: string, name: string): Promise<ChatChannel> {
    return this.options.request<ChatChannel>(
      `/teams/${encodeURIComponent(teamId)}/channels`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
  }

  async deleteTeamChannel(teamId: string, channelId: string): Promise<void> {
    await this.options.request<void>(
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
      { method: "DELETE" },
    );
  }

  /** `team.updated` frames: settings, members, channels, or the team is gone. */
  subscribeTeamUpdates(listener: (event: TeamUpdatedEvent) => void): () => void {
    return this.options.socket.subscribeCloudEvent("team.updated", (data) => {
      const event = data as Partial<TeamUpdatedEvent> | null;
      if (!event || typeof event.teamId !== "string") return;
      const change = event.change;
      if (change !== "settings" && change !== "members" && change !== "channels" && change !== "deleted") return;
      listener({ teamId: event.teamId, change });
    });
  }

  subscribeTeamNotifications(listener: TeamNotificationListener): () => void {
    return this.options.socket.subscribeTeamNotifications(listener);
  }

  subscribeCloudEvent(type: string, listener: CloudEventListener): () => void {
    return this.options.socket.subscribeCloudEvent(type, listener);
  }
}
