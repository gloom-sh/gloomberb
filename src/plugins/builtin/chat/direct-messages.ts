import type { ChatChannel, ChatUserSummary } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { t, tf } from "../../../i18n";

/**
 * The server's code for "this user only takes DMs from people they have
 * written to first". Any other refusal, a block among them, stays the neutral
 * generic line so the reason never reads as "they blocked you".
 */
const DMS_CLOSED_CODE = "dms_closed";

/** Why a DM cannot be started: the user's own setting, or an account nobody can DM (a bot, a bridged Discord user). */
type DirectMessageRefusal = "dms-off" | "no-dms";

export type DirectMessageAvailability =
  | { kind: "self" }
  /** A DM with this user exists; opening it needs no new conversation. */
  | { kind: "open"; channelId: string }
  | { kind: "start" }
  | { kind: "refused"; reason: DirectMessageRefusal };

function normalizedUsername(user: Pick<ChatUserSummary, "username">): string | null {
  return user.username?.trim().replace(/^@+/, "").toLowerCase() || null;
}

export function findDirectChannelWith(channels: readonly ChatChannel[], user: Pick<ChatUserSummary, "id" | "username">): ChatChannel | null {
  const username = normalizedUsername(user);
  return channels.find((channel) => {
    if (channel.kind !== "direct" || !channel.dmUser) return false;
    if (channel.dmUser.id === user.id) return true;
    return !!username && normalizedUsername(channel.dmUser) === username;
  }) ?? null;
}

function refusalOf(user: ChatUserSummary): DirectMessageRefusal | null {
  if (user.accountType === "managed_llm" || user.accountType === "discord") return "no-dms";
  if (user.acceptUnknownDms === false) return "dms-off";
  return null;
}

/**
 * What "Message @name" does for this user: open the DM you already share,
 * start one, or nothing. The server only lets you start a DM with someone
 * whose settings take DMs from people they have not talked to; one that
 * already exists stays open to both sides. A summary from an older server
 * that leaves the setting out is assumed to take DMs.
 */
export function directMessageAvailability(
  user: ChatUserSummary,
  { currentUserId, channels }: { currentUserId: string | null | undefined; channels: readonly ChatChannel[] },
): DirectMessageAvailability {
  if (currentUserId && user.id === currentUserId) return { kind: "self" };
  const existing = findDirectChannelWith(channels, user);
  if (existing) return { kind: "open", channelId: existing.id };
  const reason = refusalOf(user);
  return reason ? { kind: "refused", reason } : { kind: "start" };
}

export interface DirectMessageAction {
  /**
   * Opens the DM you already share, starts one, or cannot: their settings or
   * the account refuse a new DM. A menu shows a refused one disabled; a card
   * or the pane menu leaves it out.
   */
  kind: "open" | "start" | "refused";
  username: string;
  /** For a menu: "Message @name", or "Open DM with @name" when one exists. */
  menuLabel: string;
  /** For a button beside the name: "Message" or "Open DM". */
  buttonLabel: string;
}

/**
 * The "Message" action on a user's name, card or message. Null for yourself
 * and before you can send. Refused for a bot, a bridged Discord user, and
 * someone who takes no DMs from people they have not talked to, unless you
 * already share one.
 */
export function directMessageAction(
  user: ChatUserSummary,
  context: { currentUserId: string | null | undefined; channels: readonly ChatChannel[]; canSend: boolean },
): DirectMessageAction | null {
  const username = normalizedUsername(user);
  if (!context.canSend || !username) return null;
  const availability = directMessageAvailability(user, context);
  if (availability.kind === "open") {
    return {
      kind: "open",
      username,
      menuLabel: tf("Open DM with @{username}", { username }),
      buttonLabel: t("Open DM"),
    };
  }
  if (availability.kind === "self") return null;
  return {
    kind: availability.kind,
    username,
    menuLabel: tf("Message @{username}", { username }),
    buttonLabel: t("Message"),
  };
}

function directMessageRefusalText(username: string, reason: DirectMessageRefusal): string {
  return reason === "dms-off"
    ? tf("@{username} only takes DMs from people they have written to first.", { username })
    : tf("@{username} does not take DMs.", { username });
}

/**
 * The first named user a group chat cannot include. Unlike a direct message,
 * a DM already shared with them does not help: every member of a new group
 * has to take DMs from people they have not talked to.
 */
function groupChatRefusal(
  usernames: readonly string[],
  userByUsername: ReadonlyMap<string, ChatUserSummary>,
): { username: string; reason: DirectMessageRefusal } | null {
  for (const username of usernames) {
    const user = userByUsername.get(username);
    const reason = user ? refusalOf(user) : null;
    if (reason) return { username, reason };
  }
  return null;
}

/**
 * What the app knows, before asking the server, about why these names cannot
 * start a conversation. Null when it knows of no reason (an unknown name, an
 * existing DM, or users who take DMs).
 */
export function knownConversationRefusal(
  usernames: readonly string[],
  {
    userByUsername,
    currentUserId,
    channels,
  }: {
    userByUsername: ReadonlyMap<string, ChatUserSummary>;
    currentUserId: string | null | undefined;
    channels: readonly ChatChannel[];
  },
): string | null {
  if (usernames.length === 1) {
    const user = userByUsername.get(usernames[0]!);
    if (!user) return null;
    const availability = directMessageAvailability(user, { currentUserId, channels });
    return availability.kind === "refused" ? directMessageRefusalText(usernames[0]!, availability.reason) : null;
  }
  const refusal = groupChatRefusal(usernames, userByUsername);
  return refusal ? directMessageRefusalText(refusal.username, refusal.reason) : null;
}

function joinUsernames(usernames: readonly string[]): string {
  return usernames.map((username) => `@${username}`).join(", ");
}

/**
 * The line shown when opening a DM or group chat failed. A name the server
 * does not know is named; a user whose settings refuse DMs from new people is
 * named with that reason; every other refusal, a block included, stays
 * neutral and only carries the status.
 */
export function describeConversationStartError(
  error: unknown,
  usernames: readonly string[],
  userByUsername: ReadonlyMap<string, ChatUserSummary>,
): string {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  if (status === 404) {
    // The server does not say which member of a group it could not find; the
    // names this app has never seen are the candidates.
    const missing = usernames.length === 1 ? usernames : usernames.filter((username) => !userByUsername.has(username));
    if (missing.length === 1) return tf("@{username} was not found.", { username: missing[0]! });
    if (missing.length > 1) return tf("{usernames} were not found.", { usernames: joinUsernames(missing) });
    return t("One of those users was not found.");
  }
  if (status === 403 && error instanceof ApiRequestError && error.code === DMS_CLOSED_CODE) {
    const named = typeof error.details?.username === "string" ? error.details.username.toLowerCase() : null;
    const username = named
      ?? (usernames.length === 1 ? usernames[0] : groupChatRefusal(usernames, userByUsername)?.username)
      ?? null;
    return username
      ? directMessageRefusalText(username, "dms-off")
      : t("Someone in that group only takes DMs from people they have written to first.");
  }
  return status
    ? tf("Could not start the conversation (error {status}).", { status })
    : t("Could not start the conversation. Check your connection and try again.");
}
