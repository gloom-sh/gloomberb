const TEAM_ACCENT_COLORS = [
  "amber",
  "blue",
  "cyan",
  "green",
  "magenta",
  "orange",
  "red",
  "violet",
] as const;

export type TeamAccentColor = (typeof TEAM_ACCENT_COLORS)[number];

export type TeamRole = "owner" | "admin" | "member";

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  accentColor: TeamAccentColor;
  shortName: string;
  allowMemberInvites: boolean;
  /** Seats the team can fill; a Team plan deal sets it, otherwise 25. */
  memberLimit?: number;
  channelId: string;
  createdAt: string;
  role: TeamRole;
  memberCount: number;
}

export interface TeamMember {
  id: string;
  role: TeamRole;
  joinedAt: string;
  user: { id: string; username: string | null; displayName: string };
}

export interface TeamInviteLink {
  token: string;
  url: string;
  teamId: string;
  createdBy: string;
  expiresAt: string;
  maxUses: number | null;
  uses: number;
  createdAt: string;
}

/** A Better Auth organization invitation as returned by /auth/organization/* endpoints. */
export interface TeamUser {
  id: string;
  username: string | null;
  displayName: string;
}

/** An invitation addressed to the signed-in person. */
export interface TeamReceivedInvitation {
  id: string;
  role: TeamRole;
  expiresAt: string;
  createdAt: string;
  team: {
    id: string;
    name: string;
    slug: string;
    accentColor: TeamAccentColor;
    shortName: string;
    memberCount: number;
  };
  inviter: TeamUser;
}

/** An invitation a team sent; the invitee is null for addresses without an account. */
export interface TeamSentInvitation {
  id: string;
  status: string;
  role: TeamRole;
  expiresAt: string;
  createdAt: string;
  inviter: TeamUser;
  invitee: TeamUser | null;
}

export interface TeamUpdatedEvent {
  teamId: string;
  change: "settings" | "members" | "channels" | "deleted";
}

export interface TeamUsernameInvitation {
  id: string;
  status: string;
  expiresAt: string;
  invitee: { id: string; username: string | null; displayName: string };
}

interface TeamActor {
  id: string;
  username: string | null;
  displayName: string;
}

interface TeamNotificationTeam {
  id: string;
  name: string;
  accentColor: TeamAccentColor;
  shortName: string;
}

type TeamNotificationData =
  | {
      kind: "team-invite";
      team: TeamNotificationTeam;
      invitationId: string;
      expiresAt: string;
      inviter: TeamActor;
    }
  | { kind: "team-joined"; team: TeamNotificationTeam; member: TeamActor }
  | {
      kind: "layout-updated";
      team: TeamNotificationTeam;
      layoutId: string;
      layoutName: string;
      revision: number;
      author: TeamActor;
    };

type TeamNotificationType = TeamNotificationData["kind"];

export interface TeamNotification {
  id: string;
  type: TeamNotificationType;
  channelId: string;
  createdAt: string;
  data: TeamNotificationData;
}
