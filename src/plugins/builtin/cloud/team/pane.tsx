import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  apiClient,
  type ChatChannel,
  type TeamInviteLink,
  type TeamMember,
  type TeamReceivedInvitation,
  type TeamSentInvitation,
  type TeamSummary,
} from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import { Button, Tabs, loadingText, usePaneFooter, type PaneHint } from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { colors } from "../../../../theme/colors";
import type { PaneProps } from "../../../../types/plugin";
import { Box, ScrollBox, Span, Text, TextAttributes, useRendererHost } from "../../../../ui";
import { isPlainKey } from "../../../../utils/keyboard";
import { usePluginAppActions } from "../../../runtime";
import { chatController } from "../../chat/controller";
import { SignInWall } from "../auth-actions";
import { useCloudUpgradeAction } from "../../shared/cloud-upgrade";
import { usePlanAccess } from "../../shared/plan-access";
import {
  canInviteToTeam,
  canManageTeam,
  describeExpiry,
  normalizeTeamChannelName,
  sortTeamChannels,
  teamAccentHex,
  teamChannelId,
  teamIdFromChannelId,
  teamPrefix,
  userHandle,
} from "./model";
import {
  TEAM_PANE_SECTIONS,
  cycleAccent,
  describeMemberCount,
  draftChanges,
  draftFromTeam,
  emptyTeamDraft,
  nextFieldId,
  sectionFieldIds,
  type TeamDraft,
} from "./pane-model";
import {
  TEAM_PANE_ID,
  consumeRequestedTeamPaneView,
  subscribeRequestedTeamPaneView,
  type TeamPaneSection,
  type TeamPaneView,
} from "./pane-request";
import {
  ChannelsSection,
  CreateTeamForm,
  InvitesSection,
  MembersSection,
  SettingsSection,
} from "./pane-sections";
import { Muted, StatusLine, TeamPaneFocusContext, type TeamPaneFocus } from "./pane-ui";
import { teamStore } from "./store";

type Message = { tone: "info" | "success" | "error"; text: string } | null;

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 402 || (error.status === 403 && /pro|organization/i.test(error.message))) {
      return "Creating a team needs a Pro plan. Joining one is free.";
    }
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

interface TeamDetails {
  members: TeamMember[];
  invitations: TeamSentInvitation[];
  links: TeamInviteLink[];
  loading: boolean;
  error: string | null;
}

const EMPTY_DETAILS: TeamDetails = { members: [], invitations: [], links: [], loading: false, error: null };

/**
 * Members, sent invitations, and invite links for the team on screen. Reloads
 * when the server says the team changed, so two people editing the same team
 * see each other's work.
 */
function useTeamDetails(team: TeamSummary | null) {
  const [details, setDetails] = useState<TeamDetails>(EMPTY_DETAILS);
  const teamId = team?.id ?? null;
  const role = team?.role ?? null;
  const allowMemberInvites = team?.allowMemberInvites ?? false;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!teamId || !role) {
      setDetails(EMPTY_DETAILS);
      return;
    }
    const current = ++generation.current;
    setDetails((previous) => ({ ...previous, loading: true, error: null }));
    const manage = canManageTeam(role);
    const canLink = manage || allowMemberInvites;
    try {
      const [membersResult, invitations, links] = await Promise.all([
        apiClient.getTeamMembers(teamId),
        manage ? apiClient.listTeamInvitations(teamId).catch(() => []) : Promise.resolve([]),
        canLink ? apiClient.listTeamInviteLinks(teamId).catch(() => []) : Promise.resolve([]),
      ]);
      if (generation.current !== current) return;
      setDetails({ members: membersResult.members, invitations, links, loading: false, error: null });
    } catch (error) {
      if (generation.current !== current) return;
      setDetails((previous) => ({ ...previous, loading: false, error: errorText(error, "Could not load the team.") }));
    }
  }, [allowMemberInvites, role, teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!teamId) return;
    return teamStore.onTeamUpdated((event) => {
      if (event.teamId === teamId && event.change !== "deleted") void reload();
    });
  }, [reload, teamId]);

  return { details, setDetails, reload };
}

function InvitationBanner({
  invitation,
  width,
  busy,
  onAccept,
  onDecline,
}: {
  invitation: TeamReceivedInvitation;
  width: number;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const accent = teamAccentHex(invitation.team.accentColor);
  return (
    <Box
      flexDirection="row"
      width={width}
      height={1}
      alignItems="center"
      gap={1}
      backgroundColor={colors.panel}
      paddingX={1}
    >
      <Text fg={accent} attributes={TextAttributes.BOLD}>{`${teamPrefix(invitation.team)} ${invitation.team.name}`}</Text>
      <Text fg={colors.text}>
        {`${userHandle(invitation.inviter)} invited you · ${describeMemberCount(invitation.team.memberCount)} · ${describeExpiry(invitation.expiresAt)}`}
      </Text>
      <Box flexGrow={1} />
      <Button label={busy ? "Joining…" : "Accept"} variant="primary" compact disabled={busy} stopPropagation onPress={onAccept} />
      <Button label="Decline" variant="ghost" compact disabled={busy} stopPropagation onPress={onDecline} />
    </Box>
  );
}

export function TeamPane({ focused, width, height, close }: PaneProps) {
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const rendererHost = useRendererHost();
  const openUpgrade = useCloudUpgradeAction();
  const plan = usePlanAccess();
  const snapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  const signedIn = useSyncExternalStore(
    (onChange) => apiClient.subscribeCurrentUser(onChange),
    () => apiClient.isVerified(),
  );
  const selfUserId = apiClient.getCurrentUser()?.id ?? null;

  const [teamId, setTeamId] = useState<string | null>(null);
  const [section, setSection] = useState<TeamPaneSection>("members");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TeamDraft>(() => emptyTeamDraft());
  const [createDraft, setCreateDraft] = useState<TeamDraft>(() => emptyTeamDraft());
  const [inviteUsername, setInviteUsername] = useState("");
  const [channelName, setChannelName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [activeField, setActiveFieldState] = useState<string | null>(null);
  const actions = useRef(new Map<string, () => void>());

  const team = useMemo(() => {
    if (teamId) return snapshot.teams.find((entry) => entry.id === teamId) ?? null;
    return snapshot.teams.find((entry) => entry.id === teamStore.getDefaultTeamId()) ?? snapshot.teams[0] ?? null;
  }, [snapshot.teams, teamId]);
  const showCreate = creating || (snapshot.loaded && snapshot.teams.length === 0);

  // Requests from commands and chips: which team, which section, or the form.
  const applyView = useCallback((view: TeamPaneView) => {
    if (view.mode === "create") {
      setCreating(true);
    } else {
      setCreating(false);
      if (view.teamId) setTeamId(view.teamId);
    }
    if (view.section) setSection(view.section);
    setMessage(null);
  }, []);
  useEffect(() => {
    const pending = consumeRequestedTeamPaneView();
    if (pending) applyView(pending);
    return subscribeRequestedTeamPaneView(applyView);
  }, [applyView]);

  // The settings draft follows the team until the person starts editing.
  const draftTeamId = useRef<string | null>(null);
  useEffect(() => {
    if (!team) return;
    if (draftTeamId.current !== team.id) {
      draftTeamId.current = team.id;
      setDraft(draftFromTeam(team));
    }
  }, [team]);
  const dirty = team ? Object.keys(draftChanges(team, draft)).length > 0 : false;
  useEffect(() => {
    // A save elsewhere (another device, a teammate) refreshes an untouched draft.
    if (team && !dirty) setDraft(draftFromTeam(team));
  }, [dirty, team]);

  const { details, setDetails, reload } = useTeamDetails(team);

  // The chat controller builds a fresh snapshot per call, so it is read
  // through a subscription and copied into state only when something changed.
  const [chat, setChat] = useState<ChatChannel[]>(() => chatController.getChannels());
  const channels = useMemo(
    () => (team
      ? sortTeamChannels(chat.filter((channel) => channel.kind === "team" && teamIdFromChannelId(channel.id) === team.id))
      : []),
    [chat, team],
  );
  const [unreadByChannel, setUnreadByChannel] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => chatController.subscribe((state) => {
    setChat((previous) => (previous === state.channels ? previous : state.channels));
    setUnreadByChannel((previous) => {
      const next = new Map<string, number>();
      for (const entry of state.channelStates) {
        if (entry.channelId.startsWith("team:") && entry.unreadCount > 0) next.set(entry.channelId, entry.unreadCount);
      }
      if (next.size === previous.size && [...next].every(([id, count]) => previous.get(id) === count)) return previous;
      return next;
    });
  }), []);
  useEffect(() => {
    if (!team) return;
    return teamStore.onTeamUpdated((event) => {
      if (event.teamId === team.id && event.change === "channels") void chatController.refreshChatState();
    });
  }, [team]);

  // Keyboard ring.
  const fieldIds = useMemo(() => sectionFieldIds({
    section: showCreate ? "create" : section,
    team: showCreate ? null : team,
    members: details.members,
    invitationIds: details.invitations.map((entry) => entry.id),
    linkTokens: details.links.map((entry) => entry.token),
    channelIds: channels.map((entry) => entry.id),
    selfUserId,
  }), [channels, details.invitations, details.links, details.members, section, selfUserId, showCreate, team]);
  useEffect(() => {
    if (activeField && !fieldIds.includes(activeField)) setActiveFieldState(fieldIds[0] ?? null);
    if (!activeField && fieldIds.length > 0) setActiveFieldState(fieldIds[0]!);
  }, [activeField, fieldIds]);
  const setActiveField = useCallback((id: string) => setActiveFieldState(id), []);
  const register = useCallback((id: string, action: (() => void) | null) => {
    if (action) actions.current.set(id, action);
    else actions.current.delete(id);
    return () => {
      if (actions.current.get(id) === action) actions.current.delete(id);
    };
  }, []);
  const focus = useMemo<TeamPaneFocus>(
    () => ({ activeField, setActiveField, focused, register }),
    [activeField, focused, register, setActiveField],
  );

  const run = useCallback(async (key: string, work: () => Promise<Message>) => {
    if (busy) return;
    setBusy(key);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (error) {
      setMessage({ tone: "error", text: errorText(error, "That did not work.") });
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const openChannel = useCallback((channel: ChatChannel | string) => {
    createPaneFromTemplate("new-chat-pane", { arg: typeof channel === "string" ? channel : channel.id });
  }, [createPaneFromTemplate]);

  const createTeam = useCallback(() => run("create", async () => {
    const created = await apiClient.createTeam({
      name: createDraft.name.trim(),
      shortName: createDraft.shortName,
      accentColor: createDraft.accentColor,
    });
    teamStore.upsertTeam(created);
    void teamStore.refresh();
    void chatController.refreshChatState();
    setCreating(false);
    setTeamId(created.id);
    setSection("invites");
    setCreateDraft(emptyTeamDraft());
    notify({ body: `${created.name} is ready. Invite people, then find its #general in chat.`, type: "success" });
    return { tone: "success", text: `Created ${teamPrefix(created)} ${created.name}. Now invite a few people.` };
  }), [createDraft, notify, run]);

  const saveSettings = useCallback(() => {
    if (!team) return;
    const changes = draftChanges(team, draft);
    if (Object.keys(changes).length === 0) return;
    void run("save", async () => {
      const updated = await apiClient.updateTeam(team.id, changes);
      teamStore.upsertTeam(updated);
      draftTeamId.current = null;
      return { tone: "success", text: "Saved." };
    });
  }, [draft, run, team]);

  const invite = useCallback(() => {
    if (!team) return;
    const username = inviteUsername.trim().replace(/^@/, "");
    if (!username) return;
    void run("invite", async () => {
      const invitation = await apiClient.inviteTeamMemberByUsername(team.id, username);
      setInviteUsername("");
      setDetails((previous) => ({
        ...previous,
        invitations: [
          {
            id: invitation.id,
            status: invitation.status,
            role: "member",
            expiresAt: invitation.expiresAt,
            createdAt: new Date().toISOString(),
            inviter: { id: selfUserId ?? "", username: apiClient.getCurrentUser()?.username ?? null, displayName: "You" },
            invitee: invitation.invitee,
          },
          ...previous.invitations.filter((entry) => entry.id !== invitation.id),
        ],
      }));
      return { tone: "success", text: `Invited ${userHandle(invitation.invitee)}. They have 7 days to accept.` };
    });
  }, [inviteUsername, run, selfUserId, setDetails, team]);

  const copyLink = useCallback(async (link: TeamInviteLink) => {
    try {
      await rendererHost.copyText(link.url);
      setMessage({ tone: "success", text: "Invite link copied." });
    } catch {
      setMessage({ tone: "info", text: link.url });
    }
  }, [rendererHost]);

  const newLink = useCallback(() => {
    if (!team) return;
    void run("link", async () => {
      const link = await apiClient.createTeamInviteLink(team.id);
      setDetails((previous) => ({ ...previous, links: [link, ...previous.links] }));
      try {
        await rendererHost.copyText(link.url);
        return { tone: "success", text: `Link copied: ${link.url}` };
      } catch {
        return { tone: "info", text: link.url };
      }
    });
  }, [rendererHost, run, setDetails, team]);

  const createChannel = useCallback(() => {
    if (!team) return;
    const name = normalizeTeamChannelName(channelName);
    if (!name) return;
    void run("channel", async () => {
      const channel = await apiClient.createTeamChannel(team.id, name);
      setChannelName("");
      await chatController.refreshChatState().catch(() => {});
      return { tone: "success", text: `#${channel.name} is ready. Open it from the list.` };
    });
  }, [channelName, run, team]);

  const acceptInvitation = useCallback((invitation: TeamReceivedInvitation) => run(`accept:${invitation.id}`, async () => {
    const joined = await apiClient.acceptTeamInvitation(invitation.id);
    teamStore.removeInvitation(invitation.id);
    teamStore.upsertTeam(joined);
    void teamStore.refresh();
    void chatController.refreshChatState();
    setCreating(false);
    setTeamId(joined.id);
    setSection("members");
    return { tone: "success", text: `You joined ${joined.name}.` };
  }), [run]);

  const declineInvitation = useCallback((invitation: TeamReceivedInvitation) => run(`decline:${invitation.id}`, async () => {
    await apiClient.rejectTeamInvitation(invitation.id);
    teamStore.removeInvitation(invitation.id);
    return { tone: "info", text: `Declined ${invitation.team.name}.` };
  }), [run]);

  useShortcut((event) => {
    if (!focused) return;
    if (event.ctrl && event.name === "s" && !showCreate && section === "settings") {
      event.preventDefault?.();
      event.stopPropagation?.();
      saveSettings();
      return;
    }
    if (isPlainKey(event, "tab") || (!event.targetEditable && isPlainKey(event, "down", "j"))) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveFieldState((current) => nextFieldId(fieldIds, current, 1));
      return;
    }
    if ((event.shift && event.name === "tab") || (!event.targetEditable && isPlainKey(event, "up", "k"))) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setActiveFieldState((current) => nextFieldId(fieldIds, current, -1));
      return;
    }
    if (activeField === "accent" && isPlainKey(event, "left", "right", "h", "l")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const delta = event.name === "left" || event.name === "h" ? -1 : 1;
      if (showCreate) setCreateDraft((current) => ({ ...current, accentColor: cycleAccent(current.accentColor, delta) }));
      else setDraft((current) => ({ ...current, accentColor: cycleAccent(current.accentColor, delta) }));
      return;
    }
    if (!event.targetEditable && activeField && isPlainKey(event, "enter", "return", "space")) {
      const action = actions.current.get(activeField);
      if (action) {
        event.preventDefault?.();
        event.stopPropagation?.();
        action();
      }
      return;
    }
    if (!event.targetEditable && !showCreate && isPlainKey(event, "1", "2", "3", "4")) {
      const target = TEAM_PANE_SECTIONS[Number(event.name) - 1];
      if (target) {
        event.preventDefault?.();
        event.stopPropagation?.();
        setSection(target.value);
      }
    }
    // "before": the app cycles panes on Tab in the normal phase; inside this
    // pane Tab walks the ring instead, like the composer and quick-add do.
  }, { allowEditable: true, phase: "before" });

  const hints = useMemo<PaneHint[]>(() => {
    if (!signedIn) return [];
    if (showCreate) {
      return snapshot.teams.length > 0
        ? [{ id: "back", key: "Esc", label: "back", onPress: () => setCreating(false) }]
        : [];
    }
    const list: PaneHint[] = [
      { id: "new", key: "n", label: "ew team", onPress: () => { setCreating(true); setMessage(null); } },
    ];
    if (team) {
      list.push({ id: "chat", key: "c", label: "hat", onPress: () => openChannel(teamChannelId(team.id)) });
      if (canInviteToTeam(team)) list.push({ id: "invite", key: "i", label: "nvite", onPress: () => setSection("invites") });
    }
    return list;
  }, [openChannel, showCreate, signedIn, snapshot.teams.length, team]);
  usePaneFooter(TEAM_PANE_ID, () => ({
    info: [
      ...(busy ? [{ id: "busy", parts: [{ text: "working", tone: "muted" as const }] }] : []),
      ...(details.loading && !busy ? [{ id: "loading", parts: [{ text: "syncing", tone: "muted" as const }] }] : []),
    ],
    hints,
  }), [busy, details.loading, hints]);

  useShortcut((event) => {
    if (!focused || !showCreate || snapshot.teams.length === 0) return;
    if (isPlainKey(event, "escape")) {
      event.preventDefault?.();
      setCreating(false);
    }
  }, { allowEditable: true });

  if (!signedIn) {
    return <SignInWall action="use teams" />;
  }

  const contentWidth = Math.max(24, width - 2);
  const banners = snapshot.invitations;
  const headerRows = 2 + (banners.length > 0 ? banners.length + 1 : 0) + (message ? 1 : 0);
  const bodyHeight = Math.max(3, height - headerRows - 1);

  return (
    <TeamPaneFocusContext value={focus}>
      <Box flexDirection="column" width={width} height={height} paddingX={1}>
        {banners.map((invitation) => (
          <InvitationBanner
            key={invitation.id}
            invitation={invitation}
            width={contentWidth}
            busy={busy === `accept:${invitation.id}` || busy === `decline:${invitation.id}`}
            onAccept={() => { void acceptInvitation(invitation); }}
            onDecline={() => { void declineInvitation(invitation); }}
          />
        ))}
        {banners.length > 0 ? <Box height={1} /> : null}

        {/* Team switcher: one pill per team in its accent, plus the form. */}
        <Box height={1} flexDirection="row" alignItems="center">
          <Tabs
            tabs={[
              ...snapshot.teams.map((entry) => ({
                label: `${teamPrefix(entry)} ${entry.name}`,
                value: entry.id,
                fg: teamAccentHex(entry.accentColor),
              })),
              ...(showCreate ? [{ label: "New team", value: "__create" }] : []),
            ]}
            activeValue={showCreate ? "__create" : team?.id ?? null}
            onSelect={(value) => {
              if (value === "__create") {
                setCreating(true);
              } else {
                setCreating(false);
                setTeamId(value);
              }
              setMessage(null);
            }}
            focused={focused}
            variant="pill"
            compact
            keyboardNavigation={false}
            addLabel={showCreate ? undefined : "+"}
            onAdd={showCreate ? undefined : () => { setCreating(true); setMessage(null); }}
          />
        </Box>

        {showCreate ? (
          <Box height={1} />
        ) : team ? (
          <Box height={1} flexDirection="row" alignItems="center" gap={2}>
            <Tabs
              tabs={TEAM_PANE_SECTIONS.map((entry) => ({
                label: entry.label,
                value: entry.value,
                ...(entry.value === "invites" && details.invitations.length > 0 ? { label: `Invites (${details.invitations.length})` } : {}),
                ...(entry.value === "members" ? { label: `Members (${team.memberCount})` } : {}),
              }))}
              activeValue={section}
              onSelect={(value) => { setSection(value as TeamPaneSection); setMessage(null); }}
              focused={focused}
              variant="underline"
              compact
              keyboardNavigation={false}
            />
            <Box flexGrow={1} />
            <Text fg={colors.textMuted}>
              <Span fg={teamAccentHex(team.accentColor)}>●</Span>
              {` ${team.role} · ${describeMemberCount(team.memberCount)}`}
            </Text>
          </Box>
        ) : (
          <Box height={1}>
            <Muted>{snapshot.loading ? loadingText("teams") : snapshot.error ?? ""}</Muted>
          </Box>
        )}

        <StatusLine message={message ?? (details.error ? { tone: "error", text: details.error } : null)} />

        <ScrollBox height={bodyHeight} scrollY focusable={false}>
          <Box flexDirection="column" width={contentWidth} paddingTop={1}>
            {showCreate ? (
              <CreateTeamForm
                draft={createDraft}
                width={contentWidth}
                busy={busy === "create"}
                hasPro={plan.hasProAccess}
                onChange={setCreateDraft}
                onCreate={() => { void createTeam(); }}
                onCancel={snapshot.teams.length > 0 ? () => setCreating(false) : null}
                onUpgrade={openUpgrade}
              />
            ) : team && section === "members" ? (
              <MembersSection
                team={team}
                members={details.members}
                selfUserId={selfUserId}
                width={contentWidth}
                busyId={busy}
                onChangeRole={(member, role) => {
                  void run(member.id, async () => {
                    const members = await apiClient.updateTeamMemberRole(team.id, member.id, role);
                    setDetails((previous) => ({ ...previous, members }));
                    return { tone: "success", text: `${userHandle(member.user)} is now ${role === "admin" ? "an admin" : "a member"}.` };
                  });
                }}
                onRemove={(member) => {
                  void run(member.id, async () => {
                    const members = await apiClient.removeTeamMember(team.id, member.id);
                    setDetails((previous) => ({ ...previous, members }));
                    void teamStore.refresh();
                    return { tone: "info", text: `Removed ${userHandle(member.user)}.` };
                  });
                }}
              />
            ) : team && section === "invites" ? (
              <InvitesSection
                team={team}
                invitations={details.invitations}
                links={details.links}
                username={inviteUsername}
                width={contentWidth}
                busy={busy}
                onUsernameChange={setInviteUsername}
                onInvite={invite}
                onCancelInvitation={(invitation) => {
                  void run(invitation.id, async () => {
                    await apiClient.cancelTeamInvitation(team.id, invitation.id);
                    setDetails((previous) => ({ ...previous, invitations: previous.invitations.filter((entry) => entry.id !== invitation.id) }));
                    return { tone: "info", text: "Invitation canceled." };
                  });
                }}
                onNewLink={newLink}
                onCopyLink={(link) => { void copyLink(link); }}
                onRevokeLink={(link) => {
                  void run(link.token, async () => {
                    await apiClient.deleteTeamInviteLink(team.id, link.token);
                    setDetails((previous) => ({ ...previous, links: previous.links.filter((entry) => entry.token !== link.token) }));
                    return { tone: "info", text: "Link revoked." };
                  });
                }}
              />
            ) : team && section === "channels" ? (
              <ChannelsSection
                team={team}
                channels={channels}
                unreadByChannel={unreadByChannel}
                channelName={channelName}
                width={contentWidth}
                busy={busy}
                onChannelNameChange={setChannelName}
                onCreate={createChannel}
                onOpen={openChannel}
                onDelete={(channel) => {
                  void run(channel.id, async () => {
                    await apiClient.deleteTeamChannel(team.id, channel.id);
                    await chatController.refreshChatState().catch(() => {});
                    return { tone: "info", text: `Deleted #${channel.name}.` };
                  });
                }}
              />
            ) : team && section === "settings" ? (
              <SettingsSection
                team={team}
                draft={draft}
                width={contentWidth}
                busy={busy}
                dirty={dirty}
                onChange={setDraft}
                onSave={saveSettings}
                onLeave={() => {
                  void run("leave", async () => {
                    await apiClient.leaveTeam(team.id);
                    teamStore.removeTeam(team.id);
                    void teamStore.refresh();
                    void chatController.refreshChatState();
                    setTeamId(null);
                    notify({ body: `You left ${team.name}.`, type: "info" });
                    if (teamStore.getSnapshot().teams.length <= 1) close?.();
                    return { tone: "info", text: `You left ${team.name}.` };
                  });
                }}
                onDelete={() => {
                  void run("delete", async () => {
                    await apiClient.deleteTeam(team.id);
                    teamStore.removeTeam(team.id);
                    void teamStore.refresh();
                    void chatController.refreshChatState();
                    setTeamId(null);
                    notify({ body: `Deleted ${team.name}.`, type: "info" });
                    if (teamStore.getSnapshot().teams.length <= 1) close?.();
                    return { tone: "info", text: `Deleted ${team.name}.` };
                  });
                }}
              />
            ) : null}
            {!showCreate && team && details.loading && details.members.length === 0 ? (
              <Muted>{loadingText()}</Muted>
            ) : null}
            {!showCreate && !team && !snapshot.loading && snapshot.loaded ? (
              <Muted>You are not in a team yet.</Muted>
            ) : null}
          </Box>
        </ScrollBox>
      </Box>
    </TeamPaneFocusContext>
  );
}

