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
import { QueryBar, loadingText, unavailableText, useFieldRing, usePaneFooter, usePaneMenuItems, usePaneTabs, type PaneFooterSegment, type PaneHint } from "../../../../components";
import { useShortcut } from "../../../../react/input";
import { colors } from "../../../../theme/colors";
import type { PaneProps } from "../../../../types/plugin";
import {
  Box,
  ScrollBox,
  Text,
  TextAttributes,
  useRendererHost,
  useUiCapabilities,
  type BoxRenderable,
  type ScrollBoxRenderable,
} from "../../../../ui";
import { isPlainKey } from "../../../../utils/keyboard";
import { usePluginAppActions, usePluginPaneState } from "../../../runtime";
import { chatController } from "../../chat/controller";
import { SignInWall } from "../auth-actions";
import { afterLayout, revealInScrollBox } from "../../../../components/ui/reveal-in-scroll-box";
import { useCloudUpgradeAction } from "../../shared/cloud-upgrade";
import { usePlanAccess } from "../../../../api-client/plan-access";
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
} from "../../../../team/model";
import {
  TEAM_PANE_SECTIONS,
  cycleAccent,
  describeMemberCount,
  draftChanges,
  draftFromTeam,
  draftProblem,
  emptyTeamDraft,
  isTextFieldId,
  nextNonTextFieldId,
  restingFieldId,
  sectionFieldIds,
  type TeamDraft,
} from "./pane-model";
import {
  TEAM_PANE_ID,
  subscribeRequestedTeamPaneView,
  type TeamPaneSection,
  type TeamPaneView,
} from "../../../../team/pane-request";
import {
  ChannelsSection,
  CreateTeamForm,
  InvitesSection,
  MembersSection,
  SettingsSection,
} from "./pane-sections";
import { Muted, PaneButton, RowReason, RowStatus, TeamPaneFocusContext, type TeamPaneFocus, type TeamRowState } from "./pane-ui";
import { teamStore } from "../../../../team/store";
import { logFailure } from "../../../../utils/log-failure";
import { useRowNotes } from "../../../../components/ui/row-notes";
import { wrapTextLines } from "../../../../utils/text-wrap";

type Message = { tone: "info" | "success" | "error"; text: string } | null;

/**
 * What the last action on one row (a member, an invitation, a link, a
 * channel, an invitation to me) came to, said on that row: `status` in its
 * status cell, `text` under it while one of its controls holds the ring.
 * Keyed `member:<id>`, `invitation:<id>`, `link:<token>`, `channel:<id>`,
 * `received:<id>`.
 */
interface RowNote {
  status: string;
  text: string;
  tone: "negative" | "warning";
}

/** An action on one row: its key, what its status cell says while it runs (none when its button says it), and if it fails. */
interface RowAction {
  row: string;
  verb?: string;
  failure: string;
}

type TeamForm = "invite" | "link" | "channel";

const NO_ROWS: readonly string[] = [];
const rowKey = (row: string) => row;

/** The row a control of the ring belongs to: `remove:m-1` is the member m-1's. */
const FIELD_ROWS: Readonly<Record<string, string>> = {
  role: "member",
  remove: "member",
  "cancel-invitation": "invitation",
  "copy-link": "link",
  "revoke-link": "link",
  "open-channel": "channel",
  "delete-channel": "channel",
  accept: "received",
  decline: "received",
};
function fieldRow(field: string | null): string | null {
  const split = field?.indexOf(":") ?? -1;
  const kind = field && split > 0 ? FIELD_ROWS[field.slice(0, split)] : undefined;
  return kind ? `${kind}:${field!.slice(split + 1)}` : null;
}

const TEAM_RING_SCOPE = "team-pane:ring";

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
  /** Why the sent invitations or the invite links did not load; the section says so instead of listing none. */
  invitationsError: string | null;
  linksError: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_DETAILS: TeamDetails = {
  members: [], invitations: [], links: [], invitationsError: null, linksError: null, loading: false, error: null,
};

/** A list the team pane loads beside the members: its rows, or why they did not load. */
async function settleList<T>(request: Promise<T[]>, fallback: string): Promise<{ rows: T[]; error: string | null }> {
  try {
    return { rows: await request, error: null };
  } catch (error) {
    return { rows: [], error: error instanceof Error && error.message ? error.message : fallback };
  }
}

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
      const none = { rows: [], error: null };
      const [membersResult, invitations, links] = await Promise.all([
        apiClient.getTeamMembers(teamId),
        manage ? settleList(apiClient.listTeamInvitations(teamId), unavailableText("Pending invitations")) : none,
        canLink ? settleList(apiClient.listTeamInviteLinks(teamId), unavailableText("Invite links")) : none,
      ]);
      if (generation.current !== current) return;
      setDetails({
        members: membersResult.members,
        invitations: invitations.rows,
        links: links.rows,
        invitationsError: invitations.error,
        linksError: links.error,
        loading: false,
        error: null,
      });
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
  state,
  onAccept,
  onDecline,
}: {
  invitation: TeamReceivedInvitation;
  width: number;
  busy: boolean;
  state?: TeamRowState;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const accent = teamAccentHex(invitation.team.accentColor);
  // One shape with or without a reason, so the banner's own box is never restyled into its wrapper.
  return (
    <Box flexDirection="column" width={width}>
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
        <RowStatus state={state} />
        {/* In the keyboard ring, ahead of the section below. */}
        <PaneButton id={`accept:${invitation.id}`} label={busy ? "Joining…" : "Accept"} variant="primary" compact disabled={busy} onPress={onAccept} />
        <PaneButton id={`decline:${invitation.id}`} label="Decline" variant="ghost" compact disabled={busy} onPress={onDecline} />
      </Box>
      <RowReason state={state} width={width} indent={1} />
    </Box>
  );
}

/** The lines a banner takes: itself, and its reason while shown. */
function bannerRows(state: TeamRowState | undefined, width: number): number {
  return 1 + (state?.reason ? wrapTextLines(state.reason, Math.max(8, width - 1)).length : 0);
}

export function TeamPane({ focused, width, height, close }: PaneProps) {
  const { createPaneFromTemplate, notify } = usePluginAppActions();
  const rendererHost = useRendererHost();
  const openUpgrade = useCloudUpgradeAction("team");
  const plan = usePlanAccess();
  const { nativePaneChrome } = useUiCapabilities();
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
  const [section, setSection] = usePluginPaneState<TeamPaneSection>("section", "members");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TeamDraft>(() => emptyTeamDraft());
  const [createDraft, setCreateDraft] = useState<TeamDraft>(() => emptyTeamDraft());
  const [inviteUsername, setInviteUsername] = useState("");
  const [channelName, setChannelName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  // What an action on one row is doing, and what the last one came to (RowNote): said on that row.
  const [busyRow, setBusyRow] = useState<{ row: string; verb?: string } | null>(null);
  const { noteFor, setNote: setRowNote, clearNotes } = useRowNotes<string, RowNote>(NO_ROWS, { key: rowKey });
  // What stopped the invite, a new link or a new channel, under its button.
  const [formError, setFormError] = useState<{ form: TeamForm; text: string } | null>(null);
  const resetMessages = useCallback(() => {
    setMessage(null);
    setFormError(null);
  }, []);
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
    resetMessages();
  }, [resetMessages]);
  useEffect(() => subscribeRequestedTeamPaneView(applyView), [applyView]);

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

  const { details, setDetails } = useTeamDetails(team);

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

  // The rows on screen, by note key: a failure on one of them is said on it, one that has left is a toast.
  const listedRows = useRef<ReadonlySet<string>>(new Set());
  listedRows.current = new Set([
    ...details.members.map((member) => `member:${member.id}`),
    ...details.invitations.map((invitation) => `invitation:${invitation.id}`),
    ...details.links.map((link) => `link:${link.token}`),
    ...channels.map((channel) => `channel:${channel.id}`),
    ...snapshot.invitations.map((invitation) => `received:${invitation.id}`),
  ]);
  // Another team's rows are others; what was said on this one's goes with it.
  useEffect(() => {
    clearNotes();
    setFormError(null);
  }, [clearNotes, team?.id]);

  // Keyboard ring.
  const fieldIds = useMemo(() => sectionFieldIds({
    section: showCreate ? "create" : section,
    team: showCreate ? null : team,
    members: details.members,
    invitationIds: details.invitations.map((entry) => entry.id),
    linkTokens: details.links.map((entry) => entry.token),
    channelIds: channels.map((entry) => entry.id),
    selfUserId,
    receivedInvitationIds: snapshot.invitations.map((entry) => entry.id),
  }), [channels, details.invitations, details.links, details.members, section, selfUserId, showCreate, snapshot.invitations, team]);
  useEffect(() => {
    if (activeField && fieldIds.includes(activeField)) return;
    const resting = restingFieldId(fieldIds, showCreate);
    if (resting !== activeField) setActiveFieldState(resting);
  }, [activeField, fieldIds, showCreate]);
  const setActiveField = useCallback((id: string) => setActiveFieldState(id), []);
  const register = useCallback((id: string, action: (() => void) | null) => {
    if (action) actions.current.set(id, action);
    else actions.current.delete(id);
    return () => {
      if (actions.current.get(id) === action) actions.current.delete(id);
    };
  }, []);
  const nodes = useRef(new Map<string, BoxRenderable>());
  const registerNode = useCallback((id: string, node: BoxRenderable | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  }, []);
  const focus = useMemo<TeamPaneFocus>(
    () => ({ activeField, setActiveField, focused, register, registerNode }),
    [activeField, focused, register, registerNode, setActiveField],
  );
  // The ring can walk past the rows on screen in a larger team. The invitation
  // banners sit above the scrolling body, so they never move it.
  const bodyScrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    if (!activeField || activeField.startsWith("accept:") || activeField.startsWith("decline:")) return;
    return afterLayout(() => revealInScrollBox(bodyScrollRef.current, nodes.current.get(activeField) ?? null));
  }, [activeField]);

  // Each result is a toast, and the last one stays in the footer until the
  // next action or view change.
  const report = useCallback((result: Message) => {
    setMessage(result);
    if (result) notify({ body: result.text, type: result.tone });
  }, [notify]);

  const run = useCallback(async (key: string, work: () => Promise<Message>) => {
    if (busy) return;
    setBusy(key);
    resetMessages();
    try {
      report(await work());
    } catch (error) {
      report({ tone: "error", text: errorText(error, "That did not work.") });
    } finally {
      setBusy(null);
    }
  }, [busy, report, resetMessages]);

  // An action on one row: its row says it is running and, if it fails while
  // the row is listed, what it ran into. What `work` returns is what became of
  // a row that has left the list (removed, revoked), a toast.
  const runRow = useCallback(async (key: string, action: RowAction, work: () => Promise<Message>) => {
    if (busy) return;
    setBusy(key);
    setBusyRow({ row: action.row, verb: action.verb });
    setRowNote(action.row, null);
    resetMessages();
    try {
      const gone = await work();
      if (gone) notify({ body: gone.text, type: gone.tone });
    } catch (error) {
      const text = errorText(error, "That did not work.");
      if (listedRows.current.has(action.row)) setRowNote(action.row, { status: action.failure, text, tone: "negative" });
      else notify({ body: text, type: "error" });
    } finally {
      setBusy(null);
      setBusyRow(null);
    }
  }, [busy, notify, resetMessages, setRowNote]);

  // A form that adds a row (an invitation, a link, a channel): the new row is
  // its result, and what stopped it goes under its button.
  const runForm = useCallback(async (form: TeamForm, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(form);
    resetMessages();
    try {
      await work();
    } catch (error) {
      setFormError({ form, text: errorText(error, "That did not work.") });
    } finally {
      setBusy(null);
    }
  }, [busy, resetMessages]);

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
    return { tone: "success", text: `${teamPrefix(created)} ${created.name} is ready. Invite people, then find its #general in chat.` };
  }), [createDraft, run]);

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
    void runForm("invite", async () => {
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
    });
  }, [inviteUsername, runForm, selfUserId, setDetails, team]);

  /** A link copied is a toast, as every copy is; one that would not copy says so on its row, with the link to copy by hand. */
  const copyLink = useCallback(async (link: TeamInviteLink) => {
    const row = `link:${link.token}`;
    setRowNote(row, null);
    try {
      await rendererHost.copyText(link.url);
      notify({ body: "Invite link copied.", type: "success" });
    } catch {
      setRowNote(row, { status: "Not copied", text: `Copy it from here: ${link.url}`, tone: "warning" });
    }
  }, [notify, rendererHost, setRowNote]);

  const newLink = useCallback(() => {
    if (!team) return;
    void runForm("link", async () => {
      const link = await apiClient.createTeamInviteLink(team.id);
      setDetails((previous) => ({ ...previous, links: [link, ...previous.links] }));
      await copyLink(link);
    });
  }, [copyLink, runForm, setDetails, team]);

  const createChannel = useCallback(() => {
    if (!team) return;
    const name = normalizeTeamChannelName(channelName);
    if (!name) return;
    void runForm("channel", async () => {
      await apiClient.createTeamChannel(team.id, name);
      setChannelName("");
      await chatController.refreshChatState()
        .catch(logFailure("cloud.team.pane", "Refresh chat channels after creating a channel failed"));
    });
  }, [channelName, runForm, team]);

  // The banner is the invitation's row: its button says it is joining, and a failure stays on it.
  const acceptInvitation = useCallback((invitation: TeamReceivedInvitation) => runRow(`accept:${invitation.id}`, { row: `received:${invitation.id}`, failure: "Join failed" }, async () => {
    const joined = await apiClient.acceptTeamInvitation(invitation.id);
    teamStore.removeInvitation(invitation.id);
    teamStore.upsertTeam(joined);
    void teamStore.refresh();
    void chatController.refreshChatState();
    setCreating(false);
    setTeamId(joined.id);
    setSection("members");
    return { tone: "success", text: `You joined ${joined.name}.` };
  }), [runRow]);

  const declineInvitation = useCallback((invitation: TeamReceivedInvitation) => runRow(`decline:${invitation.id}`, { row: `received:${invitation.id}`, verb: "Declining…", failure: "Decline failed" }, async () => {
    await apiClient.rejectTeamInvitation(invitation.id);
    teamStore.removeInvitation(invitation.id);
    return { tone: "info", text: `Declined ${invitation.team.name}.` };
  }), [runRow]);

  // The team strip is a row of tabs no key reaches (1-4 pick the section), so
  // [ and ] step through teams, from the create form too.
  const cycleTeam = useCallback((delta: number) => {
    const teams = snapshot.teams;
    if (teams.length === 0) return;
    const index = showCreate ? -1 : teams.findIndex((entry) => entry.id === team?.id);
    const next = index < 0
      ? teams[delta > 0 ? 0 : teams.length - 1]
      : teams[(index + delta + teams.length) % teams.length];
    if (!next || (next.id === team?.id && !showCreate)) return;
    setCreating(false);
    setTeamId(next.id);
    resetMessages();
  }, [resetMessages, showCreate, snapshot.teams, team?.id]);
  const canCycleTeams = snapshot.teams.length > (showCreate ? 0 : 1);

  // Tab, j/k and Enter on the ring; the keys below are the pane's own.
  useFieldRing({
    ids: fieldIds,
    activeId: activeField,
    onActivate: setActiveField,
    enabled: focused,
    scope: TEAM_RING_SCOPE,
    wrapArrows: true,
    actions: (id) => actions.current.get(id),
  });
  useShortcut((event) => {
    const consume = () => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    if (event.ctrl && event.name === "s" && !showCreate && section === "settings") {
      consume();
      saveSettings();
      return;
    }
    if (isPlainKey(event, "escape")) {
      if (showCreate && snapshot.teams.length > 0) {
        consume();
        setCreating(false);
      } else if (isTextFieldId(activeField)) {
        // Leaves the field for the control after it, so letters are keys again.
        consume();
        setActiveFieldState(nextNonTextFieldId(fieldIds, activeField));
      }
      return;
    }
    if (activeField === "accent" && isPlainKey(event, "left", "right", "h", "l")) {
      consume();
      const delta = event.name === "left" || event.name === "h" ? -1 : 1;
      if (showCreate) setCreateDraft((current) => ({ ...current, accentColor: cycleAccent(current.accentColor, delta) }));
      else setDraft((current) => ({ ...current, accentColor: cycleAccent(current.accentColor, delta) }));
      return;
    }
    if (!event.targetEditable && canCycleTeams && isPlainKey(event, "[", "]")) {
      consume();
      cycleTeam(event.name === "[" ? -1 : 1);
      return;
    }
    if (!event.targetEditable && !showCreate && isPlainKey(event, "1", "2", "3", "4")) {
      const target = TEAM_PANE_SECTIONS[Number(event.name) - 1];
      if (target) {
        consume();
        setSection(target.value);
      }
    }
  }, { allowEditable: true, phase: "before", scope: TEAM_RING_SCOPE, enabled: focused });

  usePaneMenuItems("team-pane:teams", () => (canCycleTeams ? [
    { id: "team-previous", label: "Previous Team", accelerator: "[", onSelect: () => cycleTeam(-1) },
    { id: "team-next", label: "Next Team", accelerator: "]", onSelect: () => cycleTeam(1) },
  ] : null), [canCycleTeams, cycleTeam]);

  const hints = useMemo<PaneHint[]>(() => {
    if (!signedIn) return [];
    if (showCreate) {
      return snapshot.teams.length > 0
        ? [{ id: "back", key: "Esc", label: "back", onPress: () => setCreating(false) }]
        : [];
    }
    const list: PaneHint[] = [
      { id: "new", key: "n", label: "ew team", onPress: () => { setCreating(true); resetMessages(); } },
    ];
    if (team) {
      list.push({ id: "chat", key: "c", label: "hat", onPress: () => openChannel(teamChannelId(team.id)) });
      if (canInviteToTeam(team)) list.push({ id: "invite", key: "i", label: "nvite", onPress: () => setSection("invites") });
      if (section === "settings" && canManageTeam(team.role)) {
        // Disabled exactly when the Save button is.
        list.push({ id: "save", key: "Ctrl+S", label: "save", onPress: saveSettings, disabled: !dirty || !!draftProblem(draft) });
      }
    }
    return list;
  }, [dirty, draft, openChannel, saveSettings, section, showCreate, signedIn, snapshot.teams.length, team]);
  const result = message ?? (details.error ? { tone: "error" as const, text: details.error } : null);
  // A row's action, or a form's, shows on its row or button; the footer has the team's own.
  const teamBusy = !!busy && !busyRow && !["invite", "link", "channel"].includes(busy);
  usePaneFooter(TEAM_PANE_ID, () => ({
    info: [
      ...(teamBusy ? [{ id: "busy", parts: [{ text: "working", tone: "muted" as const }] }] : []),
      ...(details.loading && !busy ? [{ id: "loading", parts: [{ text: "syncing", tone: "muted" as const }] }] : []),
      ...(result && !busy ? [{
        id: "result",
        parts: [{
          text: result.text,
          tone: result.tone === "error" ? "negative" as const : result.tone === "success" ? "positive" as const : "muted" as const,
        }],
      } satisfies PaneFooterSegment] : []),
    ],
    hints,
  }), [busy, details.loading, hints, result, teamBusy]);

  // While one of a row's controls holds the ring, the row's reason shows in full under it.
  const selectedRow = fieldRow(activeField);
  const rowState = useCallback((row: string): TeamRowState | undefined => {
    if (busyRow?.row === row) return busyRow.verb ? { status: { text: busyRow.verb, tone: "warning" } } : undefined;
    const note = noteFor(row);
    return note ? { status: { text: note.status, tone: note.tone }, reason: selectedRow === row ? note.text : null } : undefined;
  }, [busyRow, noteFor, selectedRow]);
  const formErrorFor = useCallback((form: TeamForm) => (formError?.form === form ? formError.text : null), [formError]);

  const teamTabs = useMemo(() => [
    ...snapshot.teams.map((entry) => ({
      label: `${teamPrefix(entry)} ${entry.name}`,
      value: entry.id,
      fg: teamAccentHex(entry.accentColor),
    })),
    ...(showCreate ? [{ label: "New team", value: "__create" }] : []),
  ], [showCreate, snapshot.teams]);
  const selectTeam = useCallback((value: string) => {
    if (value === "__create") {
      setCreating(true);
    } else {
      setCreating(false);
      setTeamId(value);
    }
    resetMessages();
  }, [resetMessages]);
  const startCreate = useCallback(() => {
    setCreating(true);
    resetMessages();
  }, [resetMessages]);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs(signedIn ? {
    tabs: teamTabs,
    activeValue: showCreate ? "__create" : team?.id ?? null,
    onSelect: selectTeam,
    focused,
    keyboardNavigation: false,
    addLabel: showCreate ? undefined : "+",
    onAdd: showCreate ? undefined : startCreate,
    variant: "pill",
    compact: true,
  } : null);

  if (!signedIn) {
    return <SignInWall placement="team-signin" width={width} height={height} action="use teams" />;
  }

  const contentWidth = Math.max(24, width - 2);
  const banners = snapshot.invitations;
  // The section bar or the teams status line; the create form has neither.
  const sectionRows = showCreate ? 0 : 1;
  const bannerHeight = banners.reduce((rows, invitation) => rows + bannerRows(rowState(`received:${invitation.id}`), width), 0);
  const headerRows = sectionRows + tabRows + (banners.length > 0 ? bannerHeight + 1 : 0);
  const bodyHeight = Math.max(3, height - headerRows);

  return (
    <TeamPaneFocusContext value={focus}>
      <Box flexDirection="column" width={width} height={height}>
        {banners.map((invitation) => (
          <InvitationBanner
            key={invitation.id}
            invitation={invitation}
            width={width}
            busy={busy === `accept:${invitation.id}` || busy === `decline:${invitation.id}`}
            state={rowState(`received:${invitation.id}`)}
            onAccept={() => { void acceptInvitation(invitation); }}
            onDecline={() => { void declineInvitation(invitation); }}
          />
        ))}
        {banners.length > 0 ? <Box height={1} /> : null}

        {/* Team switcher: one pill per team in its accent, plus the form. */}
        {tabStrip && <Box height={1} flexDirection="row" alignItems="center" paddingX={1}>{tabStrip}</Box>}

        {showCreate ? null : team ? (
          <QueryBar
            width={width}
            filters={[{
              id: "section",
              label: "Section",
              inline: true,
              value: section,
              options: TEAM_PANE_SECTIONS,
              onChange: (value: TeamPaneSection) => { setSection(value); resetMessages(); },
            }]}
            meta={team.role}
          />
        ) : (
          <Box height={1} paddingX={1}>
            <Muted>{snapshot.loading ? loadingText("teams") : snapshot.error ?? ""}</Muted>
          </Box>
        )}

        {/* The desktop section bar is taller than a cell, so the body takes what is left. */}
        <ScrollBox
          ref={bodyScrollRef}
          {...(nativePaneChrome ? { flexGrow: 1, flexBasis: 0, minHeight: 0 } : { height: bodyHeight })}
          scrollY
          focusable={false}
        >
          <Box flexDirection="column" width={contentWidth + 2} paddingX={1} paddingTop={1}>
            {showCreate ? (
              <CreateTeamForm
                draft={createDraft}
                width={contentWidth}
                height={Math.max(1, bodyHeight - 1)}
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
                rowState={rowState}
                onChangeRole={(member, role) => {
                  // The row's role says the change took; nothing else does.
                  void runRow(member.id, { row: `member:${member.id}`, verb: "Changing…", failure: "Change failed" }, async () => {
                    const members = await apiClient.updateTeamMemberRole(team.id, member.id, role);
                    setDetails((previous) => ({ ...previous, members }));
                    return null;
                  });
                }}
                onRemove={(member) => {
                  void runRow(member.id, { row: `member:${member.id}`, verb: "Removing…", failure: "Remove failed" }, async () => {
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
                invitationsError={details.invitationsError}
                linksError={details.linksError}
                username={inviteUsername}
                width={contentWidth}
                busy={busy}
                rowState={rowState}
                formError={formErrorFor}
                onUsernameChange={(value) => {
                  setInviteUsername(value);
                  if (formError?.form === "invite") setFormError(null);
                }}
                onInvite={invite}
                onCancelInvitation={(invitation) => {
                  void runRow(invitation.id, { row: `invitation:${invitation.id}`, verb: "Canceling…", failure: "Cancel failed" }, async () => {
                    await apiClient.cancelTeamInvitation(team.id, invitation.id);
                    setDetails((previous) => ({ ...previous, invitations: previous.invitations.filter((entry) => entry.id !== invitation.id) }));
                    return { tone: "info", text: invitation.invitee ? `Canceled the invitation to ${userHandle(invitation.invitee)}.` : "Invitation canceled." };
                  });
                }}
                onNewLink={newLink}
                onCopyLink={(link) => { void copyLink(link); }}
                onRevokeLink={(link) => {
                  void runRow(link.token, { row: `link:${link.token}`, verb: "Revoking…", failure: "Revoke failed" }, async () => {
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
                rowState={rowState}
                formError={formErrorFor("channel")}
                onChannelNameChange={(value) => {
                  setChannelName(value);
                  if (formError?.form === "channel") setFormError(null);
                }}
                onCreate={createChannel}
                onOpen={openChannel}
                onDelete={(channel) => {
                  void runRow(channel.id, { row: `channel:${channel.id}`, verb: "Deleting…", failure: "Delete failed" }, async () => {
                    await apiClient.deleteTeamChannel(team.id, channel.id);
                    await chatController.refreshChatState()
                      .catch(logFailure("cloud.team.pane", "Refresh chat channels after deleting a channel failed"));
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

