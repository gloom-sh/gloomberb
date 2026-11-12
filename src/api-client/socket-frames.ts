import { logFailure } from "../utils/log-failure";
import { recordServerClockSample } from "../market-data/quotes/clock";
import type {
  AuthUser,
  ChatMessage,
  ChatNotification,
  ChatReactionsUpdate,
  ScannerKind,
  TeamNotification,
} from "./types";
import {
  normalizeChatChannelStateFrame,
  normalizeChatMessage,
  normalizeChatNotification,
  normalizeChatReactions,
  normalizeTeamNotification,
} from "./normalizers";
import type { SocketListeners } from "./socket-listeners";

const SCANNER_MESSAGE_KINDS: Record<string, ScannerKind> = {
  "scanner.hilo": "hilo",
  "scanner.flow": "flow",
};

/** The server's hello on a connection. */
export type SocketReadyFrame = {
  features?: unknown;
  user?: Partial<AuthUser> | null;
};

/** Where a server frame goes: its listeners, or the socket itself for the frames that change the session. */
export type SocketFrameRoutes = {
  listeners: SocketListeners;
  /** "ready", once the server clock reading it carries is taken. */
  ready: (frame: SocketReadyFrame) => void;
  /** "auth.unverified": the server holds the session's user unverified. */
  unverified: () => void;
  /** One quote: a market.quote frame, or one item of a market.quotes batch. */
  quote: (frame: unknown) => void;
};

/**
 * Reads one server frame and hands it on, in one synchronous pass. A frame that does not parse is logged; a frame
 * of a type nobody listens for is dropped.
 */
export function dispatchSocketFrame(raw: string, routes: SocketFrameRoutes): void {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logFailure("cloud-socket", "WebSocket message decoding failed")(error);
    return;
  }
  const { listeners } = routes;

  if (parsed?.type === "ready") {
    recordServerClockSample(parsed.serverTime);
    routes.ready(parsed);
    return;
  }

  if (parsed?.type === "auth.unverified") {
    routes.unverified();
    return;
  }

  if (
    parsed?.type === "chat.message" &&
    typeof parsed.channelId === "string" &&
    parsed.data
  ) {
    listeners.chatChannels.emit(parsed.channelId, normalizeChatMessage(parsed.data as ChatMessage));
    return;
  }

  if (
    parsed?.type === "chat.reactions" &&
    typeof parsed.channelId === "string" &&
    typeof parsed.data?.messageId === "string"
  ) {
    const update: ChatReactionsUpdate = {
      channelId: parsed.channelId,
      messageId: parsed.data.messageId,
      reactions: normalizeChatReactions(parsed.data.reactions),
    };
    listeners.chatReactions.emit(update);
    return;
  }

  if (parsed?.type === "chat.notification" && parsed.data) {
    listeners.chatNotifications.emit(normalizeChatNotification(parsed.data as ChatNotification));
    return;
  }

  if (parsed?.type === "chat.mentions_changed") {
    listeners.chatMentionCandidates.emit();
    return;
  }
  if (parsed?.type === "chat.channel_state") {
    const state = normalizeChatChannelStateFrame(parsed.data);
    if (state) listeners.chatChannelState.emit(state);
    return;
  }

  if (parsed?.type === "team.notification" && parsed.data) {
    listeners.teamNotifications.emit(normalizeTeamNotification(parsed.data as TeamNotification));
    return;
  }

  if (
    parsed?.type === "chat.presence" &&
    typeof parsed.onlineCount === "number"
  ) {
    listeners.chatPresence.emit(parsed.onlineCount);
    return;
  }

  if (parsed?.type === "tape.snapshot" && parsed.data && typeof parsed.data.symbol === "string" && typeof parsed.data.exchange === "string") {
    listeners.tape.emit(parsed.data.symbol, parsed.data.exchange, { type: "data", payload: parsed.data });
    return;
  }

  const scannerKind =
    typeof parsed?.type === "string"
      ? SCANNER_MESSAGE_KINDS[parsed.type]
      : undefined;
  if (scannerKind) {
    const { type: _type, ...payload } = parsed;
    listeners.scanners.emit(scannerKind, { type: "data", payload });
    return;
  }

  if (parsed?.type === "scanner.denied") {
    const denied = SCANNER_MESSAGE_KINDS[`scanner.${parsed.scanner}`];
    if (denied) {
      listeners.scanners.emit(denied, {
        type: "denied",
        reason:
          typeof parsed.reason === "string" ? parsed.reason : "pro_required",
      });
    }
    return;
  }

  if (parsed?.type === "market.quote") {
    routes.quote(parsed);
    return;
  }

  if (parsed?.type === "market.quotes") {
    recordServerClockSample(parsed.at);
    if (!Array.isArray(parsed.quotes)) return;
    // One synchronous pass: every item lands before the next data frame.
    for (const item of parsed.quotes) routes.quote(item);
    return;
  }

  if (typeof parsed?.type === "string") {
    listeners.cloudEvents.emit(parsed.type, parsed.data);
  }
}
