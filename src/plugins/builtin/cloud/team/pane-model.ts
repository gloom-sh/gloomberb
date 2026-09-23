import type {
  TeamAccentColor,
  TeamMember,
  TeamSummary,
} from "../../../../api-client";
import {
  TEAM_ACCENT_COLORS,
  canInviteToTeam,
  canManageTeam,
  deriveTeamShortName,
  normalizeTeamShortName,
  teamChannelId,
} from "./model";
import type { TeamPaneSection } from "./pane-request";

export const TEAM_PANE_SECTIONS: readonly { value: TeamPaneSection; label: string }[] = [
  { value: "members", label: "Members" },
  { value: "invites", label: "Invites" },
  { value: "channels", label: "Channels" },
  { value: "settings", label: "Settings" },
];

/** The create form and the settings form share one draft shape. */
export interface TeamDraft {
  name: string;
  shortName: string;
  /** True once the person typed a short name; until then it follows the name. */
  shortNameEdited: boolean;
  accentColor: TeamAccentColor;
  allowMemberInvites: boolean;
}

export function draftFromTeam(team: TeamSummary): TeamDraft {
  return {
    name: team.name,
    shortName: team.shortName,
    shortNameEdited: true,
    accentColor: team.accentColor,
    allowMemberInvites: team.allowMemberInvites,
  };
}

export function emptyTeamDraft(seed = Math.random()): TeamDraft {
  const accent = TEAM_ACCENT_COLORS[Math.floor(seed * TEAM_ACCENT_COLORS.length) % TEAM_ACCENT_COLORS.length] ?? "blue";
  return { name: "", shortName: "", shortNameEdited: false, accentColor: accent, allowMemberInvites: false };
}

/** Typing a name keeps the short name in step until it was edited by hand. */
export function setDraftName(draft: TeamDraft, name: string): TeamDraft {
  return {
    ...draft,
    name,
    shortName: draft.shortNameEdited ? draft.shortName : (name.trim() ? deriveTeamShortName(name) : ""),
  };
}

export function setDraftShortName(draft: TeamDraft, shortName: string): TeamDraft {
  const normalized = normalizeTeamShortName(shortName);
  return { ...draft, shortName: normalized, shortNameEdited: normalized.length > 0 };
}

export function cycleAccent(current: TeamAccentColor, delta: number): TeamAccentColor {
  const index = TEAM_ACCENT_COLORS.indexOf(current);
  const next = (index + delta + TEAM_ACCENT_COLORS.length) % TEAM_ACCENT_COLORS.length;
  return TEAM_ACCENT_COLORS[next] ?? current;
}

export function draftProblem(draft: TeamDraft): string | null {
  if (!draft.name.trim()) return "Give the team a name.";
  if (draft.name.trim().length > 40) return "Team names are at most 40 characters.";
  if (!draft.shortName) return "Pick a short name of 1 to 4 letters or digits.";
  return null;
}

/** Only what changed goes to the server, so a no-op save is a no-op. */
export function draftChanges(team: TeamSummary, draft: TeamDraft): {
  name?: string;
  shortName?: string;
  accentColor?: TeamAccentColor;
  allowMemberInvites?: boolean;
} {
  const changes: ReturnType<typeof draftChanges> = {};
  if (draft.name.trim() !== team.name) changes.name = draft.name.trim();
  if (draft.shortName !== team.shortName) changes.shortName = draft.shortName;
  if (draft.accentColor !== team.accentColor) changes.accentColor = draft.accentColor;
  if (draft.allowMemberInvites !== team.allowMemberInvites) changes.allowMemberInvites = draft.allowMemberInvites;
  return changes;
}

/**
 * The keyboard walks a ring of field ids per section. Buttons, inputs, the
 * accent picker, and the checkbox all take part, in reading order, so Tab and
 * the arrows reach everything a mouse can. Invitations addressed to me sit in
 * banners above every section, so their answers lead the ring.
 */
export function sectionFieldIds(input: {
  section: TeamPaneSection | "create";
  team: TeamSummary | null;
  members: readonly TeamMember[];
  invitationIds: readonly string[];
  linkTokens: readonly string[];
  channelIds: readonly string[];
  selfUserId: string | null;
  receivedInvitationIds?: readonly string[];
}): string[] {
  const banners = (input.receivedInvitationIds ?? []).flatMap((id) => [`accept:${id}`, `decline:${id}`]);
  return [...banners, ...sectionControlIds(input)];
}

function sectionControlIds(input: Parameters<typeof sectionFieldIds>[0]): string[] {
  const { section, team } = input;
  if (section === "create") {
    return ["name", "shortName", "accent", "create"];
  }
  if (!team) return [];
  const manage = canManageTeam(team.role);
  if (section === "members") {
    if (!manage) return [];
    return input.members.flatMap((member) =>
      member.role === "owner" || member.user.id === input.selfUserId
        ? []
        : [`role:${member.id}`, `remove:${member.id}`],
    );
  }
  if (section === "invites") {
    const ids: string[] = [];
    if (manage) ids.push("invite-username", "invite-send");
    if (manage) ids.push(...input.invitationIds.map((id) => `cancel-invitation:${id}`));
    if (canInviteToTeam(team)) {
      ids.push("new-link");
      for (const token of input.linkTokens) ids.push(`copy-link:${token}`, `revoke-link:${token}`);
    }
    return ids;
  }
  if (section === "channels") {
    const ids: string[] = [];
    for (const channelId of input.channelIds) {
      ids.push(`open-channel:${channelId}`);
      if (manage && channelId !== teamChannelId(team.id)) ids.push(`delete-channel:${channelId}`);
    }
    ids.push("channel-name", "channel-create");
    return ids;
  }
  // settings
  const ids: string[] = [];
  if (manage) ids.push("name", "shortName", "accent", "allowMemberInvites", "save");
  ids.push(team.role === "owner" ? "delete" : "leave");
  return ids;
}

const TEXT_FIELD_IDS = new Set(["name", "shortName", "invite-username", "channel-name"]);

/** A text input takes every typed letter while it holds the ring. */
export function isTextFieldId(id: string | null): boolean {
  return id !== null && TEXT_FIELD_IDS.has(id);
}

/**
 * Where the ring rests on arrival. A text input there would swallow the pane's
 * letter keys before the person chose to type, so a ring that opens on one
 * rests nowhere until Tab or j reaches it. The create form is for typing and
 * starts in its name.
 */
export function restingFieldId(ids: readonly string[], creating: boolean): string | null {
  const first = ids[0] ?? null;
  return creating || !isTextFieldId(first) ? first : null;
}

/** The first control after `current` that is not a text input, where Esc leaves a field for. */
export function nextNonTextFieldId(ids: readonly string[], current: string | null): string | null {
  const start = current ? ids.indexOf(current) : -1;
  for (let offset = 1; offset <= ids.length; offset += 1) {
    const candidate = ids[(start + offset) % ids.length];
    if (candidate && !isTextFieldId(candidate)) return candidate;
  }
  return null;
}

export function nextFieldId(ids: readonly string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index === -1) return delta >= 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(index + delta + ids.length) % ids.length]!;
}

export function describeMemberCount(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}

export function shortenInviteUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}
