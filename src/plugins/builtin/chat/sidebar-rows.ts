import type { ChatChannel, TeamSummary } from "../../../api-client";
import { sortTeamChannels } from "../cloud/team/model";
import type { ChatSidebarSection } from "./sidebar-store";

interface SidebarHeaderBase {
  /** Stable row key, also the keyboard cursor's id for a header. */
  key: string;
  channels: ChatChannel[];
  expanded: boolean;
}

export type ChatSidebarRow =
  | (SidebarHeaderBase & { kind: "public-header" })
  | (SidebarHeaderBase & { kind: "team-header"; teamId: string; team: TeamSummary | null })
  | (SidebarHeaderBase & { kind: "direct-header" })
  | { kind: "channel"; key: string; channel: ChatChannel; teamId: string | null };

export type ChatSidebarHeaderRow = Exclude<ChatSidebarRow, { kind: "channel" }>;

export function isChatSidebarHeader(row: ChatSidebarRow): row is ChatSidebarHeaderRow {
  return row.kind !== "channel";
}

/** The key of the section header a channel sits under. */
export function chatSidebarHeaderKey(channel: ChatChannel): string {
  if (channel.kind === "team") return `team-header:${channel.teamId ?? channel.id}`;
  if (channel.kind === "direct" || channel.kind === "group") return "direct-header";
  return "public-header";
}

/**
 * The rows the channel sidebar draws, top to bottom: public channels, one
 * section per team (sorted by team name), then DMs. The sidebar renders this
 * list and the keyboard cursor walks it, so arrows land exactly on what is
 * drawn, headers included, and never inside a folded section.
 */
export function buildChatSidebarRows({
  channels,
  collapsedSections,
  collapsedTeams,
  canCreateConversation,
  getTeam,
}: {
  channels: readonly ChatChannel[];
  collapsedSections: ReadonlySet<ChatSidebarSection>;
  collapsedTeams: ReadonlySet<string>;
  canCreateConversation: boolean;
  getTeam: (teamId: string | undefined) => TeamSummary | null;
}): ChatSidebarRow[] {
  const publicChannels = channels.filter((channel) => (channel.kind ?? "public") === "public");
  const conversationChannels = channels.filter((channel) => channel.kind === "direct" || channel.kind === "group");
  // A channel whose team is not loaded yet still shows, under its own id, so
  // nothing disappears while the team store refreshes.
  const byTeam = new Map<string, { team: TeamSummary | null; channels: ChatChannel[] }>();
  for (const channel of channels) {
    if (channel.kind !== "team") continue;
    const teamId = channel.teamId ?? channel.id;
    const entry = byTeam.get(teamId) ?? { team: getTeam(channel.teamId) ?? null, channels: [] };
    entry.channels.push(channel);
    byTeam.set(teamId, entry);
  }
  const teamSections = [...byTeam.entries()]
    .map(([teamId, entry]) => ({ teamId, team: entry.team, channels: sortTeamChannels(entry.channels) }))
    .sort((a, b) => (a.team?.name ?? "").localeCompare(b.team?.name ?? ""));

  const publicExpanded = !collapsedSections.has("public");
  const directExpanded = !collapsedSections.has("direct");
  const rows: ChatSidebarRow[] = [];
  if (publicChannels.length > 0) {
    rows.push({ kind: "public-header", key: "public-header", channels: publicChannels, expanded: publicExpanded });
    if (publicExpanded) {
      for (const channel of publicChannels) rows.push({ kind: "channel", key: channel.id, channel, teamId: null });
    }
  }
  for (const section of teamSections) {
    const expanded = !collapsedTeams.has(section.teamId);
    rows.push({
      kind: "team-header",
      key: `team-header:${section.teamId}`,
      teamId: section.teamId,
      team: section.team,
      channels: section.channels,
      expanded,
    });
    if (expanded) {
      for (const channel of section.channels) rows.push({ kind: "channel", key: channel.id, channel, teamId: section.teamId });
    }
  }
  if (conversationChannels.length > 0 || canCreateConversation) {
    rows.push({ kind: "direct-header", key: "direct-header", channels: conversationChannels, expanded: directExpanded });
    if (directExpanded) {
      for (const channel of conversationChannels) rows.push({ kind: "channel", key: channel.id, channel, teamId: null });
    }
  }
  return rows;
}
