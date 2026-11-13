import type { TapeFeedEvent } from "./tape";
import type {
  AuthUser,
  ChatChannelState,
  ChatMessage,
  ChatNotification,
  ChatReactionsUpdate,
  CloudQuotePayload,
  QuoteStreamTarget,
  ScannerFeedEvent,
  ScannerKind,
  TeamNotification,
} from "./types";
import { debugLog } from "../utils/debug-log";
import { canonicalExchange, normalizeSymbol } from "../utils/exchanges";
import { connectionHealth, type ConnectionHealthRegistry } from "../core/connection-health";
import { SocketConnection } from "./socket-connection";
import { SocketFeatures } from "./socket-features";
import { dispatchSocketFrame, type SocketFrameRoutes, type SocketReadyFrame } from "./socket-frames";
import { SocketListeners } from "./socket-listeners";
import { QuoteStreamSubscriptions } from "./socket-quotes";

export { CHAT_ATTACHMENTS_FEATURE, TERMINAL_RELAY_FEATURE } from "./socket-features";
export { SOCKET_CONNECT_TIMEOUT_MS, SOCKET_FIRST_RECONNECT_MAX_MS, SOCKET_PING_ANSWER_MS, SOCKET_QUIET_PING_MS } from "./socket-connection";

const cloudApiLog = debugLog.createLogger("cloud-api");

type ChatNotificationListener = (notification: ChatNotification) => void;
type ChatChannelStateListener = (state: ChatChannelState) => void;
type ChatPresenceListener = (onlineCount: number) => void;
type ChatReactionsListener = (update: ChatReactionsUpdate) => void;
type TeamNotificationListener = (notification: TeamNotification) => void;
type CloudEventListener = (data: unknown) => void;
type ScannerListener = (event: ScannerFeedEvent) => void;

type CloudApiSocketDelegate = {
  getBaseUrl: () => string;
  getSocketAuthToken: () => string | null;
  hasSessionCredential: () => boolean;
  hasVerifiedUser: () => boolean;
  isUsingWebSocketToken: () => boolean;
  clearWebSocketTokenForFallback: () => boolean;
  markCurrentUserUnverified: () => void;
  updateCurrentUserFromSocket: (user: Partial<AuthUser>) => void;
  /** The service answered on this connection (it opened, or sent a frame); see `CloudApiRequestTransport.noteServiceAnswered`. */
  onServiceAnswered?: () => void;
};

type ChatSendMessage = (
  content: string,
  replyToId?: string,
  clientMessageId?: string,
  attachmentIds?: string[],
) => Promise<ChatMessage>;

type ChatChannelConnection = {
  send: ChatSendMessage;
  close: () => void;
};

/**
 * The app's realtime link to Gloom Cloud: quotes, chat, team and scanner
 * feeds over one WebSocket. It keeps the connection open while anything
 * listens and decides what each subscription needs from it; the connection
 * itself, inbound frames, quote batching, feature negotiation and the listener
 * registries live in the `socket-*` modules beside it.
 */
export class CloudApiSocket {
  private readonly listeners = new SocketListeners();
  private readonly connection: SocketConnection;
  private readonly quotes: QuoteStreamSubscriptions;
  private readonly features: SocketFeatures;
  private readonly frameRoutes: SocketFrameRoutes;

  constructor(
    private readonly delegate: CloudApiSocketDelegate,
    health: ConnectionHealthRegistry = connectionHealth,
  ) {
    this.connection = new SocketConnection(delegate, health, {
      wanted: () => this.shouldKeepSocketOpen(),
      logCounts: () => ({
        quoteTargets: this.quotes.size,
        channelTargets: this.listeners.chatChannels.size,
      }),
      opened: () => this.replaySubscriptions(),
      received: (raw) => void this.handleSocketMessage(raw),
      interrupted: () => this.listeners.tape.emitAll({ type: "disconnected", reason: "Stream disconnected; observed window may contain gaps" }),
      closed: () => this.listeners.connection.emit("closed"),
    });
    const send = (payload: Record<string, unknown>) => this.connection.send(payload);
    this.quotes = new QuoteStreamSubscriptions({
      openSocket: () => this.connection.openSocket(),
      send,
    });
    this.features = new SocketFeatures({
      send,
      perpsOffered: (socket) => this.quotes.setPerpsConnection(socket),
    });
    this.frameRoutes = {
      listeners: this.listeners,
      ready: (frame) => this.handleReady(frame),
      unverified: () => this.handleUnverified(),
      quote: (frame) => this.quotes.deliver(frame),
    };
  }

  syncAuthState(options: { reconnect?: boolean } = {}): void {
    if (!this.shouldKeepSocketOpen()) {
      this.teardown();
      return;
    }
    if (options.reconnect) {
      this.teardown();
    }
    this.connection.ensureOpen();
  }

  teardown(): void {
    this.listeners.tape.emitAll({ type: "reset", reason: "Stream session changed" });
    this.connection.close();
  }

  connectChannel(
    channelId: string,
    onMessage: (msg: ChatMessage) => void,
    onError: ((err: string) => void) | undefined,
    sendMessage: ChatSendMessage,
  ): ChatChannelConnection {
    if (!channelId) {
      return {
        send: async () => {
          throw new Error("Channel id is required");
        },
        close: () => {},
      };
    }

    const firstListener = this.listeners.chatChannels.add(channelId, onMessage);
    this.connection.ensureOpen();
    if (firstListener) {
      this.connection.send({ type: "chat.subscribe", channelId });
    }

    return {
      send: async (content, replyToId, clientMessageId, attachmentIds) => {
        try {
          const message = await sendMessage(
            content,
            replyToId,
            clientMessageId,
            attachmentIds,
          );
          onMessage(message);
          return message;
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
      close: () => {
        const removal = this.listeners.chatChannels.remove(channelId, onMessage);
        if (removal === "unknown-key") return;
        if (removal === "last") {
          this.connection.send({ type: "chat.unsubscribe", channelId });
        }
        this.releaseSocket();
      },
    };
  }

  subscribeChatNotifications(listener: ChatNotificationListener): () => void {
    return this.listeners.chatNotifications.add(listener);
  }

  subscribeChatMentionCandidatesChanged(listener: () => void): () => void {
    return this.listeners.chatMentionCandidates.add(listener);
  }

  /**
   * The reader's read state or mute changed on another device or window. Like
   * notifications, it never opens the socket by itself.
   */
  subscribeChatChannelState(listener: ChatChannelStateListener): () => void {
    return this.listeners.chatChannelState.add(listener);
  }

  /** A message's reactions changed in a channel this socket reads. */
  subscribeChatReactions(listener: ChatReactionsListener): () => void {
    return this.listeners.chatReactions.add(listener);
  }

  subscribeChatPresence(listener: ChatPresenceListener): () => void {
    return this.listeners.chatPresence.add(listener);
  }

  /** Whether the server's last "ready" frame offered this protocol feature. */
  serverOffers(feature: string): boolean {
    return this.features.offers(feature);
  }

  subscribeServerFeatures(listener: () => void): () => void {
    return this.features.subscribe(listener);
  }

  /** "ready" after each server hello (features negotiated), "closed" when that connection ends. */
  subscribeConnection(listener: (event: "ready" | "closed") => void): () => void {
    return this.listeners.connection.add(listener);
  }

  /** Sends one frame on the open connection; false when there is none. */
  sendFrame(payload: Record<string, unknown>): boolean {
    return this.connection.sendFrame(payload);
  }

  subscribeTeamNotifications(listener: TeamNotificationListener): () => void {
    const remove = this.listeners.teamNotifications.add(listener);
    this.syncAuthState();
    return () => {
      remove();
      this.releaseSocket();
    };
  }

  /** Subscribes to a server push frame by type, e.g. a team layout update. */
  subscribeCloudEvent(type: string, listener: CloudEventListener): () => void {
    this.listeners.cloudEvents.add(type, listener);
    this.syncAuthState();
    return () => {
      this.listeners.cloudEvents.remove(type, listener);
      this.releaseSocket();
    };
  }

  /**
   * Subscribes to a shared server-computed scanner. Every open pane of the same
   * kind shares one upstream subscription; the socket fans the payload out.
   */
  subscribeScanner(
    scanner: ScannerKind,
    listener: ScannerListener,
  ): () => void {
    const firstListener = this.listeners.scanners.add(scanner, listener);
    this.connection.ensureOpen();
    if (firstListener) {
      this.connection.send({ type: "scanner.subscribe", scanner });
    } else {
      const snapshot = this.listeners.scanners.snapshot(scanner);
      if (snapshot) listener(snapshot);
    }

    return () => {
      const removal = this.listeners.scanners.remove(scanner, listener);
      if (removal !== "removed" && removal !== "last") return;
      if (removal === "last") {
        this.connection.send({ type: "scanner.unsubscribe", scanner });
      }
      this.releaseSocket();
    };
  }

  subscribeTape(symbol: string, exchange: string, listener: (event: TapeFeedEvent) => void): () => void {
    const target = { symbol: normalizeSymbol(symbol), exchange: canonicalExchange(exchange) };
    const firstListener = this.listeners.tape.add(target, listener);
    this.connection.ensureOpen();
    if (firstListener) this.connection.send({ type: "tape.subscribe", ...target });
    return () => {
      const removal = this.listeners.tape.remove(target, listener);
      if (removal !== "removed" && removal !== "last") return;
      if (removal === "last") this.connection.send({ type: "tape.unsubscribe", ...target });
      this.releaseSocket();
    };
  }

  subscribeQuotes(
    targets: QuoteStreamTarget[],
    onQuote: (target: QuoteStreamTarget, quote: CloudQuotePayload) => void,
  ): () => void {
    const subscription = this.quotes.subscribe(targets, onQuote);
    this.connection.ensureOpen();
    subscription.announce();
    return () => {
      subscription.release();
      this.releaseSocket();
    };
  }

  dispose(): void {
    cloudApiLog.info("dispose api client", {
      quoteTargets: this.quotes.size,
      channelTargets: this.listeners.chatChannels.size,
    });
    this.listeners.clear();
    this.features.clearListeners();
    this.quotes.clear();
    this.connection.resetBackoff();
    this.teardown();
  }

  async handleSocketMessage(raw: string): Promise<void> {
    dispatchSocketFrame(raw, this.frameRoutes);
  }

  private handleReady(frame: SocketReadyFrame): void {
    this.features.negotiate(this.connection.socket, frame.features);
    if (frame.user) {
      cloudApiLog.info("websocket ready", {
        emailVerified: frame.user.emailVerified === true,
      });
      this.delegate.updateCurrentUserFromSocket(frame.user);
    }
    this.listeners.connection.emit("ready");
  }

  private handleUnverified(): void {
    cloudApiLog.warn("websocket marked unverified");
    if (
      this.delegate.isUsingWebSocketToken() &&
      this.delegate.clearWebSocketTokenForFallback()
    ) {
      this.connection.resetBackoff();
      cloudApiLog.warn(
        "cleared websocket token after auth rejection; falling back to session token",
      );
      this.teardown();
      this.connection.scheduleReconnect();
      return;
    }
    this.delegate.markCurrentUserUnverified();
    if (this.hasMarketStreams()) {
      return;
    }
    this.teardown();
  }

  /** Quotes, scanners and tapes stream signed out too, so they keep the connection without a verified account. */
  private hasMarketStreams(): boolean {
    return this.quotes.size > 0 || this.listeners.scanners.size > 0 || this.listeners.tape.size > 0;
  }

  private shouldKeepSocketOpen(): boolean {
    if (this.hasMarketStreams()) return true;
    return (
      this.delegate.hasSessionCredential() &&
      this.delegate.hasVerifiedUser() &&
      (this.listeners.chatChannels.size > 0 ||
        this.listeners.teamNotifications.size > 0 ||
        this.listeners.cloudEvents.size > 0)
    );
  }

  /** A listener left: the connection closes once nothing needs it. */
  private releaseSocket(): void {
    if (!this.shouldKeepSocketOpen()) {
      this.teardown();
    }
  }

  /** A connection opened: every subscription goes out on it, chat, tapes and scanners first, then quotes. */
  private replaySubscriptions(): void {
    // The full set goes out now; queued diffs from before the open are part of it.
    this.quotes.dropPending();
    if (!this.connection.openSocket()) return;

    for (const channelId of this.listeners.chatChannels.keys()) {
      this.connection.send({ type: "chat.subscribe", channelId });
    }

    for (const market of this.listeners.tape.markets()) {
      this.connection.send({ type: "tape.subscribe", symbol: market.symbol, exchange: market.exchange });
    }

    for (const scanner of this.listeners.scanners.keys()) {
      this.connection.send({ type: "scanner.subscribe", scanner });
    }

    this.quotes.replay();
  }
}
