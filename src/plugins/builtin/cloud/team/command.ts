import { apiClient } from "../../../../api-client";
import type { CommandResultDef, GloomPluginContext } from "../../../../types/plugin";
import { requestAuthDialog } from "../auth-dialog";
import {
  canInviteToTeam,
  canManageTeam,
  describeTeam,
  findTeam,
  teamChannelId,
  teamLabel,
  userHandle,
} from "./model";
import { openTeamPane, type TeamPaneSection } from "./pane-request";
import { teamStore } from "./store";

const TEAM_SUBCOMMAND = /^(invite|new|settings|members|channels|leave|focus|chat)\b\s*(.*)$/i;

function requireSignIn(ctx: GloomPluginContext): boolean {
  if (apiClient.isVerified()) return true;
  const opened = requestAuthDialog({ mode: apiClient.isSignedIn() ? "login" : "signup" });
  if (!opened) ctx.notify({ body: "Sign in to use teams.", type: "info" });
  return false;
}

function open(ctx: GloomPluginContext, view: { teamId?: string | null; section?: TeamPaneSection; mode?: "team" | "create" }) {
  openTeamPane(ctx.createPaneFromTemplate, view);
}

function openTeamChannel(ctx: GloomPluginContext, teamId: string) {
  ctx.createPaneFromTemplate("new-chat-pane", { arg: teamChannelId(teamId) });
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** `TEAM invite @user` sends straight away; `TEAM invite link` copies a fresh link. */
async function inviteFromCommand(ctx: GloomPluginContext, teamId: string, target: string | null) {
  const team = teamStore.getTeam(teamId);
  if (!team) return;
  if (target === "link") {
    try {
      const link = await apiClient.createTeamInviteLink(team.id);
      ctx.notify({ body: `Invite link for ${team.name}: ${link.url}`, type: "success" });
    } catch (error) {
      ctx.notify({ body: errorText(error, "Could not create an invite link."), type: "error" });
    }
    return;
  }
  if (target) {
    try {
      const invitation = await apiClient.inviteTeamMemberByUsername(team.id, target.replace(/^@/, ""));
      ctx.notify({ body: `Invited ${userHandle(invitation.invitee)} to ${team.name}.`, type: "success" });
    } catch (error) {
      ctx.notify({ body: errorText(error, "Could not send the invitation."), type: "error" });
    }
    return;
  }
  open(ctx, { teamId: team.id, section: "invites" });
}

function buildTeamCommandResults(ctx: GloomPluginContext, arg: string): CommandResultDef[] {
  const snapshot = teamStore.getSnapshot();
  const trimmed = arg.trim();
  const sub = TEAM_SUBCOMMAND.exec(trimmed);
  const category = "Teams";

  if (!apiClient.isVerified()) {
    return [{
      id: "sign-in",
      label: "Sign in to use teams",
      detail: "Teams share layouts, notes, watchlists, and chat channels.",
      category,
      right: "TEAM",
      execute: () => {
        requireSignIn(ctx);
      },
    }];
  }

  const focused = teamStore.getTeam(teamStore.getDefaultTeamId()) ?? snapshot.teams[0] ?? null;

  if (sub) {
    const verb = sub[1]!.toLowerCase();
    const rest = sub[2]?.trim() ?? "";
    if (verb === "new") {
      return [{
        id: "new",
        label: "New team",
        detail: "Name, short name, accent color. Needs Pro; joining is free.",
        category,
        right: "TEAM",
        execute: () => open(ctx, { mode: "create" }),
      }];
    }
    if (verb === "invite") {
      const teams = snapshot.teams.filter(canInviteToTeam);
      if (teams.length === 0) {
        return [{
          id: "invite:none",
          label: "No team to invite to",
          detail: "Create one with TEAM new.",
          category,
          right: "TEAM",
          disabled: true,
          execute: () => {},
        }];
      }
      const linkOnly = rest.toLowerCase() === "link";
      const username = !linkOnly && rest.startsWith("@") ? rest : null;
      return teams.map((team) => ({
        id: `invite:${team.id}`,
        label: linkOnly
          ? `Copy an invite link for ${team.name}`
          : username
            ? `Invite ${username} to ${team.name}`
            : `Invite people to ${team.name}`,
        detail: linkOnly ? "Anyone with the link joins as a member." : describeTeam(team),
        category,
        right: team.shortName,
        current: focused?.id === team.id,
        execute: () => inviteFromCommand(ctx, team.id, linkOnly ? "link" : username),
      }));
    }
    if (verb === "settings" || verb === "members" || verb === "channels" || verb === "leave" || verb === "chat") {
      const section: TeamPaneSection = verb === "leave" ? "settings" : verb === "chat" ? "channels" : verb;
      const teams = verb === "settings"
        ? snapshot.teams.filter((team) => canManageTeam(team.role))
        : snapshot.teams;
      const named = rest ? findTeam(teams, rest) : null;
      return (named ? [named] : teams).map((team) => ({
        id: `${verb}:${team.id}`,
        label: verb === "leave"
          ? `Leave ${team.name}`
          : verb === "chat"
            ? `Open ${team.name} chat`
            : `${team.name}: ${section}`,
        detail: describeTeam(team),
        category,
        right: team.shortName,
        current: focused?.id === team.id,
        execute: () => {
          if (verb === "chat") openTeamChannel(ctx, team.id);
          else open(ctx, { teamId: team.id, section });
        },
      }));
    }
    if (verb === "focus") {
      return buildFocusResults(ctx, rest);
    }
  }

  const results: CommandResultDef[] = [];
  for (const invitation of snapshot.invitations) {
    results.push({
      id: `invitation:${invitation.id}`,
      label: `Invitation to ${invitation.team.name}`,
      detail: `From ${userHandle(invitation.inviter)}. Accept or decline in the team pane.`,
      category: "Invitations",
      right: "NEW",
      execute: () => open(ctx, {}),
    });
  }

  const matched = trimmed ? findTeam(snapshot.teams, trimmed) : null;
  const teams = trimmed
    ? snapshot.teams.filter((team) =>
        matched ? team.id === matched.id : teamLabel(team).toLowerCase().includes(trimmed.toLowerCase()),
      )
    : snapshot.teams;
  for (const team of teams) {
    results.push({
      id: `team:${team.id}`,
      label: teamLabel(team),
      detail: `${describeTeam(team)} · members, invites, channels, settings`,
      category,
      right: team.shortName,
      keywords: [team.name, team.shortName, team.slug],
      current: teamStore.getDefaultTeamId() === team.id,
      execute: () => open(ctx, { teamId: team.id }),
    });
  }

  if (!trimmed) {
    results.push({
      id: "new",
      label: snapshot.teams.length === 0 ? "Create a team" : "New team",
      detail: snapshot.teams.length === 0
        ? "Share layouts, notes, watchlists, and chat channels. Needs Pro; joining is free."
        : "TEAM new",
      category,
      right: "TEAM",
      execute: () => open(ctx, { mode: "create" }),
    });
  }

  if (results.length === 0) {
    results.push({
      id: "none",
      label: `No team matches "${trimmed}"`,
      detail: "TEAM lists your teams. TEAM new creates one.",
      category,
      right: "TEAM",
      disabled: true,
      execute: () => {},
    });
  }
  return results;
}

/** FOCUS lens: collapse other groups' tabs and mute their channels. */
function buildFocusResults(ctx: GloomPluginContext, arg: string): CommandResultDef[] {
  const snapshot = teamStore.getSnapshot();
  const current = snapshot.focus;
  const trimmed = arg.trim().toLowerCase();
  const results: CommandResultDef[] = [
    {
      id: "focus:all",
      label: "All",
      detail: "Every tab and channel.",
      category: "Focus",
      right: "FOCUS",
      current: current === "all",
      execute: () => {
        teamStore.setFocus("all");
        ctx.notify({ body: "Focus: everything.", type: "info" });
      },
    },
    {
      id: "focus:personal",
      label: "Personal",
      detail: "Team tabs collapse and team channels go quiet.",
      category: "Focus",
      right: "FOCUS",
      current: current === "personal",
      execute: () => {
        teamStore.setFocus("personal");
        ctx.notify({ body: "Focus: personal.", type: "info" });
      },
    },
    ...snapshot.teams.map((team) => ({
      id: `focus:${team.id}`,
      label: teamLabel(team),
      detail: "Only this team's tabs and channels, and its content by default in owner pickers.",
      category: "Focus",
      right: team.shortName,
      current: typeof current === "object" && current.teamId === team.id,
      keywords: [team.name, team.shortName],
      execute: () => {
        teamStore.setFocus({ teamId: team.id });
        ctx.notify({ body: `Focus: ${team.name}.`, type: "info" });
      },
    })),
  ];
  if (!trimmed) return results;
  const matched = findTeam(snapshot.teams, trimmed);
  return results.filter((result) =>
    matched ? result.id === `focus:${matched.id}` : result.label.toLowerCase().includes(trimmed),
  );
}

export function registerTeamCommands(ctx: GloomPluginContext): void {
  ctx.registerCommand({
    id: "team",
    label: "Team",
    description: "Your teams: members, invites, channels, settings",
    keywords: ["team", "teams", "invite", "members", "channels", "collaborate", "share"],
    category: "navigation",
    shortcut: "TEAM",
    shortcutArg: {
      placeholder: "[team | new | invite [@user|link] | members | channels | settings | leave | focus]",
      kind: "text",
      parse: (arg) => ({ query: arg.trim() }),
    },
    buildResults: (arg) => buildTeamCommandResults(ctx, arg),
    execute: async (values) => {
      const query = values?.query ?? values?.shortcut ?? "";
      if (!requireSignIn(ctx)) return;
      if (!query.trim()) {
        // Plain TEAM opens the pane: the current team, or the form when there is none.
        open(ctx, {});
        return;
      }
      const results = buildTeamCommandResults(ctx, query);
      const first = results.find((result) => !result.disabled);
      if (!first) return;
      await first.execute();
    },
  });

  ctx.registerCommand({
    id: "team-focus",
    label: "Focus",
    description: "Show one team, personal only, or everything",
    keywords: ["focus", "team", "personal", "lens", "collapse", "mute"],
    category: "navigation",
    shortcut: "FOCUS",
    shortcutArg: {
      placeholder: "[all | personal | team]",
      kind: "text",
      parse: (arg) => ({ query: arg.trim() }),
    },
    hidden: () => !apiClient.isVerified() || teamStore.getSnapshot().teams.length === 0,
    buildResults: (arg) => buildFocusResults(ctx, arg),
    execute: async (values) => {
      const query = values?.query ?? values?.shortcut ?? "";
      const results = buildFocusResults(ctx, query);
      const target = query.trim() ? results[0] : results.find((result) => result.current) ?? results[0];
      await target?.execute();
    },
  });

}
