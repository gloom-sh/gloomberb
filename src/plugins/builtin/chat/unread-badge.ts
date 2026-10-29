import type { ChatChannel } from "../../../api-client";
import { appBadgeLabel } from "../../../notifications/app-badge";
import type { NotificationLogEntry } from "../../../notifications/notification-log";
import { unreadNotificationLogCount } from "../../../notifications/notification-log";
import type { ChatControllerSnapshot } from "./controller/state";

type UnreadSnapshot = Pick<ChatControllerSnapshot, "channelStates" | "hasSavedSession" | "user">;
type BadgeSnapshot = UnreadSnapshot & Pick<ChatControllerSnapshot, "channels" | "unreadPeople">;

/**
 * What the Unread list holds as unread, and what the status bar counts: the
 * unread messages of every channel and the missed notices not yet read. Zero
 * signed out, where the status bar shows no count either.
 */
export function unreadTotal(snapshot: UnreadSnapshot, notices: readonly NotificationLogEntry[]): number {
  if (!snapshot.user && !snapshot.hasSavedSession) return 0;
  const chat = snapshot.channelStates.reduce((total, state) => total + Math.max(0, state.unreadCount), 0);
  return chat + unreadNotificationLogCount(notices);
}

/** DMs and group chats: what only the people in them read, and every message in them is for you. */
function isPeopleConversation(channel: ChatChannel | undefined): boolean {
  return channel?.kind === "direct" || channel?.kind === "group";
}

/** The newest unread message for you, and where it is. */
interface LatestUnreadForYou {
  channelId: string;
  /** Null for a DM whose unread messages are not on this device: it opens at the conversation. */
  messageId: string | null;
  senderName: string;
  /** It came in a DM or group chat; otherwise it mentions or replies to you. */
  direct: boolean;
}

/** Who wants you: the people the app badge counts, and the newest of their messages. */
export interface UnreadForYou {
  /** The person who wrote to you last; null when nobody wants you. */
  latest: LatestUnreadForYou | null;
  /** Everyone who sent you an unread DM or group message, or mentioned or replied to you, each once. */
  people: number;
  /** Their unread messages for you. */
  messages: number;
}

const NOBODY: UnreadForYou = { latest: null, people: 0, messages: 0 };

/**
 * Everyone who sent you an unread DM or group message, and everyone whose
 * unread message in any other channel mentions or replies to you, each once
 * however many messages they sent or where; with the newest of those
 * messages and how many there are. Untagged channel messages are not for
 * you. Nobody signed out.
 */
export function unreadForYou(snapshot: BadgeSnapshot): UnreadForYou {
  if (!snapshot.user && !snapshot.hasSavedSession) return NOBODY;
  const channels = new Map(snapshot.channels.map((channel) => [channel.id, channel]));
  const people = new Set<string>();
  let latest: LatestUnreadForYou | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  let messages = 0;
  for (const [channelId, who] of Object.entries(snapshot.unreadPeople)) {
    const direct = isPeopleConversation(channels.get(channelId));
    for (const id of direct ? who.senders : who.mentioners) people.add(id);
    messages += who.forYouCount;
    const newest = who.latestForYou;
    if (!newest || newest.at <= latestAt) continue;
    latest = { channelId, messageId: newest.messageId, senderName: newest.senderName, direct };
    latestAt = newest.at;
  }
  return { latest, people: people.size, messages };
}

/**
 * What the app badge counts: people, not messages ({@link unreadForYou}),
 * then every missed notice not yet read. Untagged channel messages add
 * nothing. Zero signed out. The status bar names the newest of those people
 * and counts the rest of the unread messages ({@link unreadTotal}).
 */
export function unreadBadgeCount(snapshot: BadgeSnapshot, notices: readonly NotificationLogEntry[]): number {
  if (!snapshot.user && !snapshot.hasSavedSession) return 0;
  return unreadForYou(snapshot).people + unreadNotificationLogCount(notices);
}

interface UnreadBadgeOptions {
  controller: {
    subscribe(listener: (snapshot: BadgeSnapshot) => void): () => void;
    /** Starts reading who the unread messages are from; the returned stop ends it. */
    trackUnreadPeople(): () => void;
  };
  log: {
    get(): readonly NotificationLogEntry[];
    subscribe(listener: () => void): () => void;
  };
  setBadge(label: string): void;
}

/**
 * Keeps the app badge on {@link unreadBadgeCount}: one `setBadge` per change
 * of the label, none while it stays the same (past 99 it reads `99+` however
 * many more arrive), and a clear when stopped, as when the plugin is turned
 * off. Signing out zeroes the count, which clears it. While it runs the
 * controller reads who the unread messages are from; a host with no badge
 * never starts it, so reads nothing extra. Returns the stop.
 */
export function watchUnreadBadge({ controller, log, setBadge }: UnreadBadgeOptions): () => void {
  let applied = "";
  let snapshot: BadgeSnapshot | null = null;

  const apply = (label: string) => {
    if (label === applied) return;
    applied = label;
    try {
      setBadge(label);
    } catch {
      // The badge is a courtesy; a host that fails must not break chat updates.
    }
  };
  const update = () => {
    if (snapshot) apply(appBadgeLabel(unreadBadgeCount(snapshot, log.get())));
  };

  const stopTracking = controller.trackUnreadPeople();
  const stopController = controller.subscribe((next) => {
    snapshot = next;
    update();
  });
  const stopLog = log.subscribe(update);

  return () => {
    stopController();
    stopLog();
    stopTracking();
    snapshot = null;
    apply("");
  };
}
