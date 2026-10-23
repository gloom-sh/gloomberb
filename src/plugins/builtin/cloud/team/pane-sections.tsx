import type {
  ChatChannel,
  TeamInviteLink,
  TeamMember,
  TeamSentInvitation,
  TeamSummary,
} from "../../../../api-client";
import { Button, Notice } from "../../../../components";
import { colors } from "../../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../../ui";
import { WallTeaser } from "../../shared/wall-teaser";
import {
  canInviteToTeam,
  canManageTeam,
  describeExpiry,
  normalizeTeamChannelName,
  roleLabel,
  teamAccentHex,
  teamChannelId,
  teamPrefix,
  userHandle,
} from "../../../../team/model";
import {
  draftProblem,
  setDraftName,
  setDraftShortName,
  shortenInviteUrl,
  type TeamDraft,
} from "./pane-model";
import {
  AccentPicker,
  AccentRow,
  ConfirmAction,
  Muted,
  PaneButton,
  PaneCheckbox,
  PaneField,
  RowStatus,
  SectionTitle,
  type TeamRowState,
} from "./pane-ui";

const LABEL_WIDTH = 12;

/** What the pane's work on one row shows, by the row's key (`member:<id>`, `invitation:<id>`, `link:<token>`, `channel:<id>`). */
export type TeamRowStates = (row: string) => TeamRowState | undefined;

/** The columns the widest status among `rows` takes with its gap, so the fixed columns give it room and the buttons stay in view. */
function statusRoom(rowState: TeamRowStates, rows: readonly string[]): number {
  return rows.reduce((room, row) => {
    const text = rowState(row)?.status?.text;
    return text ? Math.max(room, text.length + 1) : room;
  }, 0);
}

/** What stopped a form (invite, a new link or channel) from going through, right under its field or button. */
function FormError({ text, width, indent = LABEL_WIDTH + 1 }: { text: string | null | undefined; width: number; indent?: number }) {
  if (!text) return null;
  return (
    <Box paddingLeft={indent} width={width}>
      <Text fg={colors.negative} wrapText width={Math.max(8, width - indent)}>{text}</Text>
    </Box>
  );
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

export function MembersSection({
  team,
  members,
  selfUserId,
  width,
  busyId,
  rowState,
  onChangeRole,
  onRemove,
}: {
  team: TeamSummary;
  members: readonly TeamMember[];
  selfUserId: string | null;
  width: number;
  busyId: string | null;
  rowState: TeamRowStates;
  onChangeRole: (member: TeamMember, role: "admin" | "member") => void;
  onRemove: (member: TeamMember) => void;
}) {
  const manage = canManageTeam(team.role);
  const accent = teamAccentHex(team.accentColor);
  const compact = width < 64;
  const handleWidth = compact ? 16 : 18;
  // The display name gives up its columns to a row's status first, for every row alike.
  const room = statusRoom(rowState, members.map((member) => `member:${member.id}`));
  const nameWidth = compact ? 0 : Math.max(0, Math.min(22, width - handleWidth - 40 - room));
  return (
    <Box flexDirection="column" gap={1} width={width}>
      <SectionTitle detail={`${members.length} of ${team.memberLimit ?? 25}`}>Members</SectionTitle>
      <Box flexDirection="column">
        {members.map((member) => {
          const self = member.user.id === selfUserId;
          const editable = manage && member.role !== "owner" && !self;
          const busy = busyId === member.id;
          const state = rowState(`member:${member.id}`);
          return (
            <AccentRow key={member.id} accent={member.role === "owner" ? accent : colors.textMuted} width={width} state={state}>
              <Text width={handleWidth} flexShrink={0} fg={self ? colors.textBright : colors.text} attributes={self ? TextAttributes.BOLD : 0}>
                {truncate(userHandle(member.user), handleWidth)}
              </Text>
              {nameWidth > 0 ? (
                <Text width={nameWidth} fg={colors.textDim}>
                  {truncate(member.user.username ? member.user.displayName : "", nameWidth)}
                </Text>
              ) : null}
              <Text width={7} fg={member.role === "owner" ? accent : colors.textDim}>
                {roleLabel(member.role)}
              </Text>
              {self ? <Text fg={colors.textMuted}>you</Text> : null}
              <Box flexGrow={1} />
              <RowStatus state={state} />
              {editable ? (
                <Box flexDirection="row" gap={1}>
                  <PaneButton
                    id={`role:${member.id}`}
                    label={member.role === "admin" ? "Make member" : "Make admin"}
                    variant="ghost"
                    disabled={busy}
                    onPress={() => onChangeRole(member, member.role === "admin" ? "member" : "admin")}
                  />
                  <ConfirmAction
                    id={`remove:${member.id}`}
                    label="Remove"
                    question={`Remove ${userHandle(member.user)}?`}
                    confirmLabel="Remove"
                    busy={busy}
                    onConfirm={() => onRemove(member)}
                  />
                </Box>
              ) : null}
            </AccentRow>
          );
        })}
      </Box>
    </Box>
  );
}

export function InvitesSection({
  team,
  invitations,
  links,
  invitationsError,
  linksError,
  username,
  width,
  busy,
  rowState,
  formError,
  onUsernameChange,
  onInvite,
  onCancelInvitation,
  onNewLink,
  onCopyLink,
  onRevokeLink,
}: {
  team: TeamSummary;
  invitations: readonly TeamSentInvitation[];
  links: readonly TeamInviteLink[];
  /** Set when that list did not load: it shows the error, not an empty list. */
  invitationsError: string | null;
  linksError: string | null;
  username: string;
  width: number;
  busy: string | null;
  rowState: TeamRowStates;
  /** What stopped the invite or a new link, by form. */
  formError: (form: "invite" | "link") => string | null;
  onUsernameChange: (value: string) => void;
  onInvite: () => void;
  onCancelInvitation: (invitation: TeamSentInvitation) => void;
  onNewLink: () => void;
  onCopyLink: (link: TeamInviteLink) => void;
  onRevokeLink: (link: TeamInviteLink) => void;
}) {
  const manage = canManageTeam(team.role);
  const canLink = canInviteToTeam(team);
  // The link gives up its columns to a row's status first, for every link alike.
  const linkStatusRoom = statusRoom(rowState, links.map((link) => `link:${link.token}`));
  return (
    <Box flexDirection="column" gap={1} width={width}>
      {manage ? (
        <Box flexDirection="column" gap={1}>
          <SectionTitle>Invite by username</SectionTitle>
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center">
              <PaneField
                id="invite-username"
                label="Username"
                value={username}
                placeholder="@analyst"
                width={Math.max(30, width - 16)}
                labelWidth={LABEL_WIDTH}
                onChange={onUsernameChange}
                onSubmit={onInvite}
              />
              <PaneButton id="invite-send" label={busy === "invite" ? "Sending…" : "Send"} variant="primary" disabled={busy === "invite" || !username.trim()} onPress={onInvite} />
            </Box>
            <FormError text={formError("invite")} width={width} />
          </Box>
        </Box>
      ) : null}

      {manage ? (
        <Box flexDirection="column" gap={1}>
          <SectionTitle detail={invitations.length === 0 && !invitationsError ? "none pending" : undefined}>Pending</SectionTitle>
          {invitationsError ? <Notice tone="negative">{invitationsError}</Notice> : null}
          {invitations.map((invitation) => {
            const state = rowState(`invitation:${invitation.id}`);
            return (
              <AccentRow key={invitation.id} accent={colors.textMuted} width={width} state={state}>
                <Text width={18} fg={colors.text}>
                  {truncate(invitation.invitee ? userHandle(invitation.invitee) : "someone by email", 18)}
                </Text>
                <Text fg={colors.textDim} truncate wrapMode="none" flexShrink={1} minWidth={0}>{`from ${userHandle(invitation.inviter)} · expires ${describeExpiry(invitation.expiresAt)}`}</Text>
                <Box flexGrow={1} />
                <RowStatus state={state} />
                <PaneButton
                  id={`cancel-invitation:${invitation.id}`}
                  label="Cancel"
                  variant="ghost"
                  disabled={busy === invitation.id}
                  onPress={() => onCancelInvitation(invitation)}
                />
              </AccentRow>
            );
          })}
        </Box>
      ) : null}

      <Box flexDirection="column" gap={1}>
        <SectionTitle detail={canLink && !linksError ? `${links.length} of 10 active` : undefined}>Invite links</SectionTitle>
        {canLink ? (
          <>
            {linksError ? <Notice tone="negative">{linksError}</Notice> : null}
            {links.map((link) => {
              const uses = link.maxUses === null ? `${link.uses} uses` : `${link.uses}/${link.maxUses} uses`;
              const state = rowState(`link:${link.token}`);
              return (
                <AccentRow key={link.token} accent={colors.textMuted} width={width} state={state}>
                  <Text fg={colors.text} flexShrink={0}>{truncate(shortenInviteUrl(link.url), Math.max(12, width - 44 - linkStatusRoom))}</Text>
                  <Text fg={colors.textDim} truncate wrapMode="none" flexShrink={1} minWidth={0}>{`· ${uses} · ${describeExpiry(link.expiresAt)}`}</Text>
                  <Box flexGrow={1} />
                  <RowStatus state={state} />
                  <PaneButton id={`copy-link:${link.token}`} label="Copy" variant="ghost" onPress={() => onCopyLink(link)} />
                  <ConfirmAction
                    id={`revoke-link:${link.token}`}
                    label="Revoke"
                    question="Revoke?"
                    confirmLabel="Revoke"
                    busy={busy === link.token}
                    onConfirm={() => onRevokeLink(link)}
                  />
                </AccentRow>
              );
            })}
            <Box flexDirection="column">
              <PaneButton id="new-link" label={busy === "link" ? "Creating…" : "New link"} disabled={busy === "link"} onPress={onNewLink} />
              <FormError text={formError("link")} width={width} indent={0} />
            </Box>
          </>
        ) : (
          <Muted width={width}>
            {`Only owners and admins of ${team.name} can share invite links. An admin can allow every member to in Settings.`}
          </Muted>
        )}
      </Box>
    </Box>
  );
}

export function ChannelsSection({
  team,
  channels,
  unreadByChannel,
  channelName,
  width,
  busy,
  rowState,
  formError,
  onChannelNameChange,
  onCreate,
  onOpen,
  onDelete,
}: {
  team: TeamSummary;
  channels: readonly ChatChannel[];
  unreadByChannel: ReadonlyMap<string, number>;
  channelName: string;
  width: number;
  busy: string | null;
  rowState: TeamRowStates;
  /** What stopped the new channel. */
  formError: string | null;
  onChannelNameChange: (value: string) => void;
  onCreate: () => void;
  onOpen: (channel: ChatChannel) => void;
  onDelete: (channel: ChatChannel) => void;
}) {
  const manage = canManageTeam(team.role);
  const accent = teamAccentHex(team.accentColor);
  const normalized = normalizeTeamChannelName(channelName);
  const general = teamChannelId(team.id);
  return (
    <Box flexDirection="column" gap={1} width={width}>
      <SectionTitle detail={`${channels.length} of 20`}>Channels</SectionTitle>
      <Box flexDirection="column">
        {channels.map((channel) => {
          const unread = unreadByChannel.get(channel.id) ?? 0;
          const state = rowState(`channel:${channel.id}`);
          return (
            <AccentRow key={channel.id} accent={accent} width={width} state={state}>
              <Text fg={unread > 0 ? colors.textBright : colors.text} attributes={unread > 0 ? TextAttributes.BOLD : 0} flexShrink={0}>
                {`#${channel.name}`}
              </Text>
              {unread > 0 ? <Text fg={accent} attributes={TextAttributes.BOLD}>{`[${unread}]`}</Text> : null}
              <Box flexGrow={1} />
              <RowStatus state={state} />
              <PaneButton id={`open-channel:${channel.id}`} label="Open" variant="ghost" onPress={() => onOpen(channel)} />
              {manage && channel.id !== general ? (
                <ConfirmAction
                  id={`delete-channel:${channel.id}`}
                  label="Delete"
                  question={`Delete #${channel.name}?`}
                  confirmLabel="Delete"
                  busy={busy === channel.id}
                  onConfirm={() => onDelete(channel)}
                />
              ) : null}
            </AccentRow>
          );
        })}
      </Box>
      <Box flexDirection="column" gap={1}>
        <SectionTitle>New channel</SectionTitle>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <PaneField
              id="channel-name"
              label="Name"
              value={channelName}
              placeholder="earnings-season"
              width={Math.max(30, width - 18)}
              labelWidth={LABEL_WIDTH}
              onChange={onChannelNameChange}
              onSubmit={onCreate}
            />
            <PaneButton id="channel-create" label={busy === "channel" ? "Creating…" : "Create"} variant="primary" disabled={busy === "channel" || !normalized} onPress={onCreate} />
          </Box>
          <FormError text={formError} width={width} />
        </Box>
        <Box paddingLeft={LABEL_WIDTH + 1}>
          <Muted>
            {normalized && normalized !== channelName.trim()
              ? `Will be #${normalized}. Letters, digits, and dashes; every member can add channels.`
              : "Letters, digits, and dashes. Every member can add channels; owners and admins remove them."}
          </Muted>
        </Box>
      </Box>
    </Box>
  );
}

function TeamDraftFields({
  draft,
  width,
  onChange,
  onSubmit,
  editable,
}: {
  draft: TeamDraft;
  width: number;
  onChange: (draft: TeamDraft) => void;
  onSubmit?: () => void;
  editable: boolean;
}) {
  return (
    <Box flexDirection="column" gap={1} width={width}>
      <PaneField
        id="name"
        label="Name"
        value={draft.name}
        placeholder="Rates Desk"
        width={Math.min(width, 56)}
        labelWidth={LABEL_WIDTH}
        onChange={(name) => onChange(setDraftName(draft, name))}
        onSubmit={onSubmit}
      />
      <PaneField
        id="shortName"
        label="Short name"
        value={draft.shortName}
        placeholder="MD"
        width={Math.min(width, 32)}
        labelWidth={LABEL_WIDTH}
        onChange={(shortName) => onChange(setDraftShortName(draft, shortName))}
        onSubmit={onSubmit}
        hint={`Up to 4 letters or digits. Marks the team's content as ${teamPrefix({ shortName: draft.shortName || "MD" })} where color cannot.`}
        hintWidth={width}
      />
      <AccentPicker
        id="accent"
        value={draft.accentColor}
        previewName={draft.name}
        previewShortName={draft.shortName}
        width={width}
        labelWidth={LABEL_WIDTH}
        onChange={(accentColor) => onChange({ ...draft, accentColor })}
      />
      {editable ? (
        <Box flexDirection="column">
          <PaneCheckbox
            id="allowMemberInvites"
            label="Members can share invite links"
            checked={draft.allowMemberInvites}
            width={width}
            onChange={(allowMemberInvites) => onChange({ ...draft, allowMemberInvites })}
          />
          <Box paddingLeft={LABEL_WIDTH + 1}>
            <Muted>Otherwise only owners and admins invite people.</Muted>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function SettingsSection({
  team,
  draft,
  width,
  busy,
  dirty,
  onChange,
  onSave,
  onLeave,
  onDelete,
}: {
  team: TeamSummary;
  draft: TeamDraft;
  width: number;
  busy: string | null;
  dirty: boolean;
  onChange: (draft: TeamDraft) => void;
  onSave: () => void;
  onLeave: () => void;
  onDelete: () => void;
}) {
  const manage = canManageTeam(team.role);
  const problem = draftProblem(draft);
  return (
    <Box flexDirection="column" gap={1} width={width}>
      {manage ? (
        <>
          <SectionTitle>Team</SectionTitle>
          <TeamDraftFields draft={draft} width={width} onChange={onChange} onSubmit={onSave} editable />
          <Box flexDirection="row" gap={1} alignItems="center">
            <PaneButton
              id="save"
              label={busy === "save" ? "Saving…" : "Save changes"}
              variant="primary"
              disabled={busy === "save" || !dirty || !!problem}
              onPress={onSave}
            />
            {problem && dirty ? <Text fg={colors.negative}>{problem}</Text> : null}
          </Box>
        </>
      ) : (
        <>
          <SectionTitle>Team</SectionTitle>
          <Box flexDirection="column">
            <Text fg={colors.textDim}>{`  Name          ${team.name}`}</Text>
            <Text fg={colors.textDim}>{`  Short name    ${team.shortName}`}</Text>
            <Text fg={colors.textDim}>{`  Accent        `}<Text fg={teamAccentHex(team.accentColor)}>{team.accentColor}</Text></Text>
            <Text fg={colors.textDim}>{`  Invite links  ${team.allowMemberInvites ? "every member" : "owners and admins"}`}</Text>
          </Box>
          <Muted width={width}>Owners and admins change these.</Muted>
        </>
      )}
      <Box height={1} />
      <SectionTitle>{team.role === "owner" ? "Delete team" : "Leave team"}</SectionTitle>
      {team.role === "owner" ? (
        <Box flexDirection="column" gap={1}>
          <Muted width={width}>
            Removes the team for everyone: its channels, shared layouts, notes, watchlists, and views. Members keep personal copies of linked tabs.
          </Muted>
          <ConfirmAction
            id="delete"
            label="Delete team"
            question={`Delete ${team.name} for everyone?`}
            confirmLabel="Delete team"
            busy={busy === "delete"}
            onConfirm={onDelete}
          />
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Muted width={width}>Your linked tabs become personal copies. Team notes and collections leave your terminal.</Muted>
          <ConfirmAction
            id="leave"
            label="Leave team"
            question={`Leave ${team.name}?`}
            confirmLabel="Leave"
            busy={busy === "leave"}
            onConfirm={onLeave}
          />
        </Box>
      )}
    </Box>
  );
}

export function CreateTeamForm({
  draft,
  width,
  height,
  busy,
  hasPro,
  onChange,
  onCreate,
  onCancel,
  onUpgrade,
}: {
  draft: TeamDraft;
  width: number;
  height: number;
  busy: boolean;
  hasPro: boolean;
  onChange: (draft: TeamDraft) => void;
  onCreate: () => void;
  onCancel: (() => void) | null;
  onUpgrade: () => void;
}) {
  const problem = draftProblem(draft);
  const form = (
    <Box flexDirection="column" gap={1} width={width}>
      {/* The "New team" tab above already names this form. */}
      <Muted width={width}>
        A team shares layouts, watchlists, paper portfolios, notes, custom views, and chat channels. Creating needs Pro; joining is free.
      </Muted>
      <TeamDraftFields draft={draft} width={width} onChange={onChange} onSubmit={onCreate} editable={false} />
      <Box flexDirection="row" gap={1} alignItems="center">
        {hasPro ? (
          <PaneButton
            id="create"
            label={busy ? "Creating…" : "Create team"}
            variant="primary"
            disabled={busy || !!problem}
            onPress={onCreate}
          />
        ) : (
          <PaneButton id="create" label="Upgrade to Pro to create teams" variant="primary" onPress={onUpgrade} />
        )}
        {onCancel ? <Button label="Cancel" variant="ghost" stopPropagation onPress={onCancel} /> : null}
        {problem && draft.name ? <Text fg={colors.negative}>{problem}</Text> : null}
      </Box>
    </Box>
  );
  // Preserve room for the editable name, short name, accent and Upgrade action.
  return hasPro ? form : (
    <WallTeaser placement="team" width={width} height={Math.max(0, height - 10)}>
      {form}
    </WallTeaser>
  );
}
