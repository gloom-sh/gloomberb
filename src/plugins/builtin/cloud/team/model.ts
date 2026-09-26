import type {
  TeamAccentColor,
  TeamNotification,
  TeamRole,
  TeamSummary,
  TeamUser,
} from "../../../../api-client";
import { blendHex, colors } from "../../../../theme/colors";

export const TEAM_CHANNEL_PREFIX = "team:";

/** The text marker for team content on terminals without color: `MD·`. */
export function teamPrefix(team: Pick<TeamSummary, "shortName">): string {
  return `${team.shortName}·`;
}

export const TEAM_ACCENT_COLORS: readonly TeamAccentColor[] = [
  "amber", "blue", "cyan", "green", "magenta", "orange", "red", "violet",
];

/** `team:<teamId>` is #general; other channels append their name. */
export function teamChannelId(teamId: string, channelName?: string): string {
  return channelName && channelName !== "general"
    ? `${TEAM_CHANNEL_PREFIX}${teamId}:${channelName}`
    : `${TEAM_CHANNEL_PREFIX}${teamId}`;
}

export function teamIdFromChannelId(channelId: string): string | null {
  if (!channelId.startsWith(TEAM_CHANNEL_PREFIX)) return null;
  const rest = channelId.slice(TEAM_CHANNEL_PREFIX.length);
  const teamId = rest.split(":")[0];
  return teamId || null;
}

/** #general first, then the rest by name, whatever order the server used. */
export function sortTeamChannels<T extends { id: string; name: string }>(channels: readonly T[]): T[] {
  return [...channels].sort((a, b) => {
    const aGeneral = a.id.split(":").length === 2;
    const bGeneral = b.id.split(":").length === 2;
    if (aGeneral !== bGeneral) return aGeneral ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** What a person types for a channel name, as the server will keep it. */
export function normalizeTeamChannelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

/** Initials for multi-word names, otherwise the first three letters; mirrors the server. */
export function deriveTeamShortName(name: string): string {
  const words = name
    .split(/[\s\-_/]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  const candidate = words.length >= 2
    ? words.slice(0, 4).map((word) => word[0] ?? "").join("")
    : (words[0] ?? "").slice(0, 3);
  return normalizeTeamShortName(candidate) || "TM";
}

export function normalizeTeamShortName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4);
}

export function userHandle(user: TeamUser): string {
  return user.username ? `@${user.username}` : user.displayName;
}

/** "in 6d", "in 3h", or "expired", for invites and links. */
export function describeExpiry(iso: string, now = Date.now()): string {
  const remaining = new Date(iso).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "expired";
  const hours = Math.round(remaining / 3_600_000);
  if (hours < 1) return "in minutes";
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * Accent tokens map onto the active theme rather than fixed hexes so a team
 * marker still reads as one of the theme's colors. Positive and negative are
 * avoided as bases for the greens and reds so a team never looks like P&L.
 */
export function teamAccentHex(accent: TeamAccentColor): string {
  switch (accent) {
    case "amber":
      return colors.warning;
    case "blue":
      return colors.borderFocused;
    case "cyan":
      return blendHex(colors.borderFocused, colors.positive, 0.5);
    case "green":
      return blendHex(colors.positive, colors.textBright, 0.3);
    case "magenta":
      return blendHex(colors.negative, colors.borderFocused, 0.45);
    case "orange":
      return blendHex(colors.warning, colors.negative, 0.4);
    case "red":
      return blendHex(colors.negative, colors.textBright, 0.25);
    case "violet":
      return blendHex(colors.borderFocused, colors.negative, 0.35);
    default:
      return colors.text;
  }
}

export function roleLabel(role: TeamRole): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

export function canManageTeam(role: TeamRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canInviteToTeam(team: Pick<TeamSummary, "role" | "allowMemberInvites">): boolean {
  return canManageTeam(team.role) || team.allowMemberInvites;
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/^[#@]+/, "").replace(/·$/, "").toLowerCase();
}

/**
 * Resolves what someone typed after `TEAM` or `CHAT` to a team: the id, the
 * short name (`MD`), the slug, or the name. Exact matches win over prefixes so
 * `rat` finds "Rates" without ambiguity when "Rates Desk" also exists.
 */
export function findTeam(
  teams: readonly TeamSummary[],
  query: string,
): TeamSummary | null {
  const needle = normalizeQuery(query);
  if (!needle) return null;
  const exact = teams.find((team) =>
    team.id === query.trim() ||
    team.shortName.toLowerCase() === needle ||
    team.slug.toLowerCase() === needle ||
    team.name.toLowerCase() === needle,
  );
  if (exact) return exact;
  const prefixed = teams.filter((team) =>
    team.name.toLowerCase().startsWith(needle) ||
    team.shortName.toLowerCase().startsWith(needle),
  );
  return prefixed.length === 1 ? prefixed[0]! : null;
}

export function teamLabel(team: Pick<TeamSummary, "name" | "shortName">): string {
  return `${teamPrefix(team)} ${team.name}`;
}

export function describeTeam(team: TeamSummary): string {
  const members = team.memberCount === 1 ? "1 member" : `${team.memberCount} members`;
  return `${roleLabel(team.role)} · ${members}`;
}

/** Toast text for the team frames the server sends. */
export function describeTeamNotification(notification: TeamNotification): {
  title: string;
  body: string;
} {
  const data = notification.data;
  const who = (actor: { username: string | null; displayName: string }) =>
    actor.username ? `@${actor.username}` : actor.displayName;
  switch (data.kind) {
    case "team-invite":
      return {
        title: teamLabel(data.team),
        body: `${who(data.inviter)} invited you to ${data.team.name}. Run TEAM to accept.`,
      };
    case "team-joined":
      return {
        title: teamLabel(data.team),
        body: `${who(data.member)} joined ${data.team.name}.`,
      };
    case "layout-updated":
      return {
        title: teamLabel(data.team),
        body: `${who(data.author)} published ${data.layoutName} r${data.revision}.`,
      };
    default:
      return { title: "Team", body: "Team update." };
  }
}

/** Unread counts per team for the status bar: pending invites and layout updates. */
export function countTeamUpdates(
  notifications: readonly TeamNotification[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const notification of notifications) {
    const teamId = notification.data.team.id;
    counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
  }
  return counts;
}
