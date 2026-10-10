import {
  apiClient,
  type TeamNotification,
  type TeamReceivedInvitation,
  type TeamSummary,
  type TeamUpdatedEvent,
} from "../../../../api-client";
import type { AppNotificationDelivery, AppNotificationRequest, PluginPersistence } from "../../../../types/plugin";
import { appendNotificationLog, markNotificationLogReadByRef } from "../../../../notifications/notification-log";
import { describeTeamNotification, findTeam, teamIdFromChannelId, teamNotificationRefId } from "./model";

export interface TeamStoreSnapshot {
  /** Teams the signed-in person belongs to, sorted by name. */
  teams: TeamSummary[];
  /** Invitations waiting on this person. */
  invitations: TeamReceivedInvitation[];
  /** Undelivered team cards: invites, joins, layout updates. */
  notifications: TeamNotification[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The FOCUS lens: everything, one team, or personal only. Per device. */
  focus: "all" | "personal" | { teamId: string };
  /** Tab groups the person folded or unfolded by hand since the last FOCUS change. */
  toggledGroups: ReadonlySet<string>;
  /** Teams whose channel section in the chat sidebar is folded. Per device. */
  collapsedTeams: ReadonlySet<string>;
}

type Listener = (snapshot: TeamStoreSnapshot) => void
type Notifier = (request: AppNotificationRequest) => AppNotificationDelivery | void

const FOCUS_STATE_KEY = "team-focus";
const NOTIFICATION_STATE_KEY = "team-notifications";
const COLLAPSED_STATE_KEY = "team-collapsed-channels";

interface TeamNotificationActions {
  openTeamChannel?: (teamId: string) => void;
  openTeamInvites?: () => void;
  openTeamLayout?: (teamId: string, layoutId: string) => void;
}

const EMPTY: TeamStoreSnapshot = {
  teams: [],
  invitations: [],
  notifications: [],
  loaded: false,
  loading: false,
  error: null,
  focus: "all",
  toggledGroups: new Set(),
  collapsedTeams: new Set(),
};

/**
 * One place that knows which teams the account is in. Other plugins read it
 * through the `cloud.team` capability, the chat sidebar and status bar read it
 * directly. Refreshes on sign-in, empties on sign-out, and folds the
 * `team.notification` frames into cards the person can act on.
 */
/** The slice of the API client the store uses, so tests can hand in a fake. */
export type TeamStoreClient = Pick<
  typeof apiClient,
  | "isVerified"
  | "subscribeCurrentUser"
  | "subscribeTeamNotifications"
  | "subscribeTeamUpdates"
  | "listTeams"
  | "listMyTeamInvitations"
  | "getTeamNotifications"
  | "markChatNotificationsDelivered"
>;

export class TeamStore {
  constructor(private readonly client: TeamStoreClient = apiClient) {}

  private snapshot: TeamStoreSnapshot = EMPTY;
  private readonly listeners = new Set<Listener>();
  private persistence: PluginPersistence | null = null;
  private notifier: Notifier | null = null;
  private actions: TeamNotificationActions = {};
  private disposers: Array<() => void> = [];
  private refreshPromise: Promise<void> | null = null;
  private started = false;

  getSnapshot(): TeamStoreSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  attach(persistence: PluginPersistence): void {
    this.persistence = persistence;
    const focus = persistence.getState<TeamStoreSnapshot["focus"]>(FOCUS_STATE_KEY);
    const notifications = persistence.getState<TeamNotification[]>(NOTIFICATION_STATE_KEY);
    const collapsed = persistence.getState<string[]>(COLLAPSED_STATE_KEY);
    this.update({
      focus: focus ?? "all",
      notifications: Array.isArray(notifications) ? notifications : [],
      collapsedTeams: new Set(Array.isArray(collapsed) ? collapsed : []),
    });
  }

  setNotifier(notifier: Notifier | null, actions: TeamNotificationActions = {}): void {
    this.notifier = notifier;
    this.actions = actions;
  }

  /** Begins following auth state and the realtime feed. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const syncAuth = () => {
      if (this.client.isVerified()) {
        void this.refresh();
      } else if (this.snapshot.loaded || this.snapshot.teams.length > 0) {
        this.update({ ...EMPTY, focus: this.snapshot.focus, collapsedTeams: this.snapshot.collapsedTeams });
      }
    };
    this.disposers.push(this.client.subscribeCurrentUser(syncAuth));
    this.disposers.push(
      this.client.subscribeTeamNotifications((notification) => this.receive(notification)),
    );
    this.disposers.push(this.client.subscribeTeamUpdates((event) => this.receiveUpdate(event)));
    syncAuth();
  }

  /** Listeners for `team.updated`, so panes showing a team refetch its details. */
  private readonly updateListeners = new Set<(event: TeamUpdatedEvent) => void>();

  onTeamUpdated(listener: (event: TeamUpdatedEvent) => void): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  private receiveUpdate(event: TeamUpdatedEvent): void {
    void this.refresh();
    for (const listener of this.updateListeners) listener(event);
  }

  /** Applies a team the server just returned without waiting for a refresh. */
  upsertTeam(team: TeamSummary): void {
    const others = this.snapshot.teams.filter((entry) => entry.id !== team.id);
    this.update({ teams: [...others, team].sort((a, b) => a.name.localeCompare(b.name)) });
  }

  removeTeam(teamId: string): void {
    const focus = this.snapshot.focus;
    this.update({
      teams: this.snapshot.teams.filter((entry) => entry.id !== teamId),
      ...(typeof focus === "object" && focus.teamId === teamId ? { focus: "all" as const } : {}),
    });
  }

  removeInvitation(invitationId: string): void {
    this.update({ invitations: this.snapshot.invitations.filter((entry) => entry.id !== invitationId) });
  }

  isTeamCollapsed(teamId: string): boolean {
    return this.snapshot.collapsedTeams.has(teamId);
  }

  toggleTeamCollapsed(teamId: string): void {
    const next = new Set(this.snapshot.collapsedTeams);
    if (next.has(teamId)) next.delete(teamId);
    else next.add(teamId);
    this.update({ collapsedTeams: next });
    this.persistence?.setState(COLLAPSED_STATE_KEY, [...next]);
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.started = false;
    this.refreshPromise = null;
  }

  getTeam(teamId: string | null | undefined): TeamSummary | null {
    if (!teamId) return null;
    return this.snapshot.teams.find((team) => team.id === teamId) ?? null;
  }

  getTeamForChannel(channelId: string): TeamSummary | null {
    return this.getTeam(teamIdFromChannelId(channelId));
  }

  findTeam(query: string): TeamSummary | null {
    return findTeam(this.snapshot.teams, query);
  }

  /** The team owner pickers default to: the focused team, else none. */
  getDefaultTeamId(): string | null {
    const focus = this.snapshot.focus;
    return typeof focus === "object" && this.getTeam(focus.teamId) ? focus.teamId : null;
  }

  setFocus(focus: TeamStoreSnapshot["focus"]): void {
    // A new lens resets hand-folded groups so the lens is what you see.
    this.update({ focus, toggledGroups: new Set() });
    this.persistence?.setState(FOCUS_STATE_KEY, focus);
  }

  /** Folds or unfolds one tab group by hand until FOCUS changes. */
  toggleGroup(groupId: string): void {
    const next = new Set(this.snapshot.toggledGroups);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    this.update({ toggledGroups: next });
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.update({ loading: true, error: null });
    this.refreshPromise = (async () => {
      try {
        const [teams, invitations, notifications] = await Promise.all([
          this.client.listTeams(),
          this.client.listMyTeamInvitations().catch(() => [] as TeamReceivedInvitation[]),
          this.client.getTeamNotifications().catch(() => null),
        ]);
        this.update({
          teams: [...teams].sort((a, b) => a.name.localeCompare(b.name)),
          invitations,
          ...(notifications ? { notifications: this.mergeNotifications(notifications) } : {}),
          loaded: true,
          loading: false,
          error: null,
        });
        this.persistNotifications();
      } catch (error) {
        this.update({
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : "Could not load teams.",
        });
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  /** Marks cards handled and tells the server so they stop coming back. */
  async dismissNotifications(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const dismissed = this.snapshot.notifications.filter((entry) => ids.includes(entry.id));
    const remaining = this.snapshot.notifications.filter((entry) => !ids.includes(entry.id));
    this.update({ notifications: remaining });
    this.persistNotifications();
    // The pending list is the team badge. The log keeps the card as history.
    this.rememberInNotificationCenter(dismissed);
    markNotificationLogReadByRef(dismissed.map((entry) => teamNotificationRefId(entry.id)));
    try {
      await this.client.markChatNotificationsDelivered([...ids]);
    } catch {
      /* The next refresh brings them back if the server never heard. */
    }
  }

  dismissNotificationsForTeam(teamId: string, kinds?: readonly TeamNotification["type"][]): Promise<void> {
    const ids = this.snapshot.notifications
      .filter((entry) => entry.data.team.id === teamId && (!kinds || kinds.includes(entry.type)))
      .map((entry) => entry.id);
    return this.dismissNotifications(ids);
  }

  private receive(notification: TeamNotification): void {
    this.update({ notifications: this.mergeNotifications([notification]) });
    this.persistNotifications();
    if (notification.type === "team-joined" || notification.type === "team-invite") {
      void this.refresh();
    }
    this.rememberInNotificationCenter([notification]);
    const { title, body } = describeTeamNotification(notification);
    const action = this.actionFor(notification);
    this.notifier?.({
      refId: teamNotificationRefId(notification.id),
      title,
      body,
      type: "info",
      source: "team",
      desktop: "when-inactive",
      ...(action ? { action } : {}),
    });
  }

  /** `at` is the card's createdAt. The toast upsert keeps that time. */
  private rememberInNotificationCenter(notifications: readonly TeamNotification[]): void {
    for (const notification of notifications) {
      const { title, body } = describeTeamNotification(notification);
      const at = Date.parse(notification.createdAt);
      appendNotificationLog({
        title,
        body,
        type: "info",
        refId: teamNotificationRefId(notification.id),
      }, "team", Number.isFinite(at) ? at : Date.now());
    }
  }

  private actionFor(notification: TeamNotification): AppNotificationRequest["action"] | null {
    const data = notification.data;
    if (data.kind === "team-invite" && this.actions.openTeamInvites) {
      return { label: "Review", onClick: () => this.actions.openTeamInvites?.() };
    }
    if (data.kind === "team-joined" && this.actions.openTeamChannel) {
      return { label: "Open chat", onClick: () => this.actions.openTeamChannel?.(data.team.id) };
    }
    if (data.kind === "layout-updated" && this.actions.openTeamLayout) {
      return {
        label: "Open layout",
        onClick: () => this.actions.openTeamLayout?.(data.team.id, data.layoutId),
      };
    }
    return null;
  }

  private mergeNotifications(incoming: readonly TeamNotification[]): TeamNotification[] {
    const byId = new Map(this.snapshot.notifications.map((entry) => [entry.id, entry]));
    for (const entry of incoming) byId.set(entry.id, entry);
    return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-100);
  }

  private persistNotifications(): void {
    this.persistence?.setState(NOTIFICATION_STATE_KEY, this.snapshot.notifications);
  }

  private update(patch: Partial<TeamStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export const teamStore = new TeamStore();
