import type { TapeFeedEvent } from "./tape";
import type {
  AuthUser,
  ChatMessage,
  ChatNotification,
  CloudQuotePayload,
  QuoteStreamTarget,
  ScannerFeedEvent,
  ScannerKind,
  TeamNotification,
} from "./types";
import {
  normalizeChatMessage,
  normalizeChatNotification,
  normalizeTeamNotification,
} from "./normalizers";
import { debugLog } from "../utils/debug-log";
import { canonicalExchange, normalizeSymbol } from "../utils/exchanges";
import { mergeQuoteSubscriptionTargets } from "../market-data/quote-subscription-target";
import {
  connectionHealth,
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  type ConnectionHealthRegistry,
} from "../core/connection-health";

const QUOTE_SUBSCRIPTION_FLUSH_MS = 25;
const cloudApiLog = debugLog.createLogger("cloud-api");

type ChannelListener = (message: ChatMessage) => void;
type ChatNotificationListener = (notification: ChatNotification) => void;
type ChatPresenceListener = (onlineCount: number) => void;
type TeamNotificationListener = (notification: TeamNotification) => void;
type CloudEventListener = (data: unknown) => void;
type QuoteListener = (
  target: QuoteStreamTarget,
  quote: CloudQuotePayload,
) => void;
type QuoteSubscription = {
  target: QuoteStreamTarget;
  listener: QuoteListener;
};
type ScannerListener = (event: ScannerFeedEvent) => void;

const SCANNER_MESSAGE_KINDS: Record<string, ScannerKind> = {
  "scanner.hilo": "hilo",
  "scanner.flow": "flow",
};

function mergeQuoteStreamSubscriptions(
  subscriptions: Iterable<QuoteSubscription>,
): QuoteStreamTarget | null {
  return mergeQuoteSubscriptionTargets(
    [...subscriptions].map((subscription) => subscription.target),
  );
}

type CloudApiSocketDelegate = {
  getBaseUrl: () => string;
  getSocketAuthToken: () => string | null;
  hasSessionCredential: () => boolean;
  hasVerifiedUser: () => boolean;
  isUsingWebSocketToken: () => boolean;
  clearWebSocketTokenForFallback: () => boolean;
  markCurrentUserUnverified: () => void;
  updateCurrentUserFromSocket: (user: Partial<AuthUser>) => void;
};

type ChatChannelConnection = {
  send: (
    content: string,
    replyToId?: string,
    clientMessageId?: string,
  ) => Promise<ChatMessage>;
  close: () => void;
};

function marketKey(symbol: string, exchange?: string): string {
  const normalizedSymbolValue = normalizeSymbol(symbol);
  const normalizedExchangeValue = canonicalExchange(exchange);
  return normalizedExchangeValue
    ? `${normalizedSymbolValue}:${normalizedExchangeValue}`
    : normalizedSymbolValue;
}

export class CloudApiSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;

  private readonly channelListeners = new Map<string, Set<ChannelListener>>();
  private readonly chatNotificationListeners =
    new Set<ChatNotificationListener>();
  private readonly chatPresenceListeners = new Set<ChatPresenceListener>();
  private readonly teamNotificationListeners =
    new Set<TeamNotificationListener>();
  private readonly cloudEventListeners = new Map<
    string,
    Set<CloudEventListener>
  >();
  private nextQuoteSubscriptionId = 1;
  private readonly quoteSubscriptions = new Map<
    string,
    Map<number, QuoteSubscription>
  >();
  private readonly quoteTargets = new Map<string, QuoteStreamTarget>();
  private readonly pendingQuoteSubscribes = new Map<
    string,
    QuoteStreamTarget
  >();
  private readonly pendingQuoteUnsubscribes = new Map<
    string,
    QuoteStreamTarget
  >();
  private quoteSubscriptionFlushTimer: ReturnType<typeof setTimeout> | null =
    null;
  private readonly tapeListeners = new Map<string, { symbol: string; exchange: string; listeners: Set<(event: TapeFeedEvent) => void> }>();
  private readonly scannerListeners = new Map<
    ScannerKind,
    Set<ScannerListener>
  >();
  /** Latest fan-out payload, so a pane opened mid-stream does not wait for the next tick. */
  private readonly scannerSnapshots = new Map<ScannerKind, ScannerFeedEvent>();

  constructor(
    private readonly delegate: CloudApiSocketDelegate,
    private readonly health: ConnectionHealthRegistry = connectionHealth,
  ) {}

  syncAuthState(options: { reconnect?: boolean } = {}): void {
    if (!this.shouldKeepSocketOpen()) {
      this.teardown();
      return;
    }
    if (options.reconnect) {
      this.teardown();
    }
    this.ensureSocket();
  }

  teardown(): void {
    this.emitTapeStatus({ type: "reset", reason: "Stream session changed" });
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      cloudApiLog.info("teardown websocket");
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "idle",
        "Socket closed locally",
      );
    }
    try {
      ws?.close();
    } catch {
      // ignore closed sockets
    }
  }

  connectChannel(
    channelId: string,
    onMessage: (msg: ChatMessage) => void,
    onError: ((err: string) => void) | undefined,
    sendMessage: (
      content: string,
      replyToId?: string,
      clientMessageId?: string,
    ) => Promise<ChatMessage>,
  ): ChatChannelConnection {
    if (!channelId) {
      return {
        send: async () => {
          throw new Error("Channel id is required");
        },
        close: () => {},
      };
    }

    const listeners =
      this.channelListeners.get(channelId) ?? new Set<ChannelListener>();
    const firstListener = listeners.size === 0;
    listeners.add(onMessage);
    this.channelListeners.set(channelId, listeners);
    this.ensureSocket();
    if (firstListener) {
      this.sendSocketMessage({ type: "chat.subscribe", channelId });
    }

    return {
      send: async (
        content: string,
        replyToId?: string,
        clientMessageId?: string,
      ) => {
        try {
          const message = await sendMessage(
            content,
            replyToId,
            clientMessageId,
          );
          onMessage(message);
          return message;
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
      close: () => {
        const current = this.channelListeners.get(channelId);
        if (!current) return;
        current.delete(onMessage);
        if (current.size === 0) {
          this.channelListeners.delete(channelId);
          this.sendSocketMessage({ type: "chat.unsubscribe", channelId });
        }
        if (!this.shouldKeepSocketOpen()) {
          this.teardown();
        }
      },
    };
  }

  subscribeChatNotifications(listener: ChatNotificationListener): () => void {
    this.chatNotificationListeners.add(listener);
    return () => {
      this.chatNotificationListeners.delete(listener);
    };
  }

  subscribeChatPresence(listener: ChatPresenceListener): () => void {
    this.chatPresenceListeners.add(listener);
    return () => {
      this.chatPresenceListeners.delete(listener);
    };
  }

  subscribeTeamNotifications(listener: TeamNotificationListener): () => void {
    this.teamNotificationListeners.add(listener);
    this.syncAuthState();
    return () => {
      this.teamNotificationListeners.delete(listener);
      if (!this.shouldKeepSocketOpen()) {
        this.teardown();
      }
    };
  }

  /** Subscribes to a server push frame by type, e.g. a team layout update. */
  subscribeCloudEvent(type: string, listener: CloudEventListener): () => void {
    const listeners =
      this.cloudEventListeners.get(type) ?? new Set<CloudEventListener>();
    listeners.add(listener);
    this.cloudEventListeners.set(type, listeners);
    this.syncAuthState();
    return () => {
      const current = this.cloudEventListeners.get(type);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.cloudEventListeners.delete(type);
        }
      }
      if (!this.shouldKeepSocketOpen()) {
        this.teardown();
      }
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
    const listeners =
      this.scannerListeners.get(scanner) ?? new Set<ScannerListener>();
    const firstListener = listeners.size === 0;
    listeners.add(listener);
    this.scannerListeners.set(scanner, listeners);
    this.ensureSocket();
    if (firstListener) {
      this.sendSocketMessage({ type: "scanner.subscribe", scanner });
    } else {
      const snapshot = this.scannerSnapshots.get(scanner);
      if (snapshot) listener(snapshot);
    }

    return () => {
      const current = this.scannerListeners.get(scanner);
      if (!current || !current.delete(listener)) return;
      if (current.size === 0) {
        this.scannerListeners.delete(scanner);
        this.scannerSnapshots.delete(scanner);
        this.sendSocketMessage({ type: "scanner.unsubscribe", scanner });
      }
      if (!this.shouldKeepSocketOpen()) {
        this.teardown();
      }
    };
  }

  subscribeTape(symbol: string, exchange: string, listener: (event: TapeFeedEvent) => void): () => void {
    const target = { symbol: normalizeSymbol(symbol), exchange: canonicalExchange(exchange) };
    const key = marketKey(target.symbol, target.exchange);
    const existing = this.tapeListeners.get(key);
    const entry = existing ?? { ...target, listeners: new Set<(event: TapeFeedEvent) => void>() };
    entry.listeners.add(listener);
    this.tapeListeners.set(key, entry);
    this.ensureSocket();
    if (!existing) this.sendSocketMessage({ type: "tape.subscribe", ...target });
    return () => {
      const current = this.tapeListeners.get(key);
      if (!current?.listeners.delete(listener)) return;
      if (!current.listeners.size) {
        this.tapeListeners.delete(key);
        this.sendSocketMessage({ type: "tape.unsubscribe", ...target });
      }
      if (!this.shouldKeepSocketOpen()) this.teardown();
    };
  }

  private emitTapeStatus(event: Exclude<TapeFeedEvent, { type: "data" }>): void {
    for (const entry of this.tapeListeners.values()) for (const listener of entry.listeners) listener(event);
  }

  subscribeQuotes(
    targets: QuoteStreamTarget[],
    onQuote: (target: QuoteStreamTarget, quote: CloudQuotePayload) => void,
  ): () => void {
    const subscriptionId = this.nextQuoteSubscriptionId++;
    const uniqueTargets = [
      ...new Map(
        targets
          .filter(
            (target) =>
              typeof target.symbol === "string" &&
              target.symbol.trim().length > 0,
          )
          .map((target) => {
            const normalized = {
              symbol: normalizeSymbol(target.symbol),
              exchange: canonicalExchange(target.exchange),
              surface: target.surface,
              visible: target.visible,
              selected: target.selected,
              weight: target.weight,
            } satisfies QuoteStreamTarget;
            return [
              marketKey(normalized.symbol, normalized.exchange),
              normalized,
            ] as const;
          }),
      ).values(),
    ];

    const newSubscriptions: QuoteStreamTarget[] = [];
    const updatedSubscriptions: QuoteStreamTarget[] = [];
    for (const target of uniqueTargets) {
      const key = marketKey(target.symbol, target.exchange);
      const subscriptions =
        this.quoteSubscriptions.get(key) ??
        new Map<number, QuoteSubscription>();
      const previousTarget = this.quoteTargets.get(key);
      subscriptions.set(subscriptionId, { target, listener: onQuote });
      this.quoteSubscriptions.set(key, subscriptions);
      const mergedTarget =
        mergeQuoteStreamSubscriptions(subscriptions.values()) ?? target;
      if (!previousTarget) {
        newSubscriptions.push(target);
      } else if (
        !this.areQuoteStreamTargetsEquivalent(previousTarget, mergedTarget)
      ) {
        updatedSubscriptions.push(mergedTarget);
      }
      this.quoteTargets.set(key, mergedTarget);
    }

    this.ensureSocket();
    const subscriptionsToSend = [...newSubscriptions, ...updatedSubscriptions];
    if (subscriptionsToSend.length > 0) {
      cloudApiLog.info("register quote listeners", {
        count: subscriptionsToSend.length,
        symbols: subscriptionsToSend.map((target) =>
          marketKey(target.symbol, target.exchange),
        ),
      });
      this.queueQuoteSubscribes(subscriptionsToSend);
    }

    return () => {
      const removedTargets: QuoteStreamTarget[] = [];
      const updatedTargets: QuoteStreamTarget[] = [];

      for (const target of uniqueTargets) {
        const key = marketKey(target.symbol, target.exchange);
        const subscriptions = this.quoteSubscriptions.get(key);
        if (!subscriptions || !subscriptions.delete(subscriptionId)) continue;
        const previousTarget = this.quoteTargets.get(key);
        if (subscriptions.size === 0) {
          this.quoteSubscriptions.delete(key);
          if (previousTarget) removedTargets.push(previousTarget);
          this.quoteTargets.delete(key);
          continue;
        }
        const mergedTarget = mergeQuoteStreamSubscriptions(
          subscriptions.values(),
        );
        if (!mergedTarget) continue;
        this.quoteTargets.set(key, mergedTarget);
        if (
          previousTarget &&
          !this.areQuoteStreamTargetsEquivalent(previousTarget, mergedTarget)
        ) {
          updatedTargets.push(mergedTarget);
        }
      }

      if (updatedTargets.length > 0) {
        this.queueQuoteSubscribes(updatedTargets);
      }

      if (removedTargets.length > 0) {
        cloudApiLog.info("remove quote listeners", {
          count: removedTargets.length,
          symbols: removedTargets.map((target) =>
            marketKey(target.symbol, target.exchange),
          ),
        });
        this.queueQuoteUnsubscribes(removedTargets);
      }

      if (!this.shouldKeepSocketOpen()) {
        this.teardown();
      }
    };
  }

  dispose(): void {
    cloudApiLog.info("dispose api client", {
      quoteTargets: this.quoteTargets.size,
      channelTargets: this.channelListeners.size,
    });
    this.channelListeners.clear();
    this.chatNotificationListeners.clear();
    this.chatPresenceListeners.clear();
    this.teamNotificationListeners.clear();
    this.cloudEventListeners.clear();
    this.quoteSubscriptions.clear();
    this.quoteTargets.clear();
    this.pendingQuoteSubscribes.clear();
    this.pendingQuoteUnsubscribes.clear();
    this.tapeListeners.clear();
    this.scannerListeners.clear();
    this.scannerSnapshots.clear();
    if (this.quoteSubscriptionFlushTimer) {
      clearTimeout(this.quoteSubscriptionFlushTimer);
      this.quoteSubscriptionFlushTimer = null;
    }
    this.reconnectDelayMs = 1000;
    this.teardown();
  }

  async handleSocketMessage(raw: string): Promise<void> {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (parsed?.type === "ready" && parsed.user) {
      cloudApiLog.info("websocket ready", {
        emailVerified: parsed.user.emailVerified === true,
      });
      this.delegate.updateCurrentUserFromSocket(
        parsed.user as Partial<AuthUser>,
      );
      return;
    }

    if (parsed?.type === "auth.unverified") {
      cloudApiLog.warn("websocket marked unverified");
      if (
        this.delegate.isUsingWebSocketToken() &&
        this.delegate.clearWebSocketTokenForFallback()
      ) {
        this.reconnectDelayMs = 1000;
        cloudApiLog.warn(
          "cleared websocket token after auth rejection; falling back to session token",
        );
        this.teardown();
        this.scheduleReconnect();
        return;
      }
      this.delegate.markCurrentUserUnverified();
      if (this.quoteTargets.size > 0 || this.scannerListeners.size > 0 || this.tapeListeners.size > 0) {
        return;
      }
      this.teardown();
      return;
    }

    if (
      parsed?.type === "chat.message" &&
      typeof parsed.channelId === "string" &&
      parsed.data
    ) {
      const message = normalizeChatMessage(parsed.data as ChatMessage);
      for (const listener of this.channelListeners.get(parsed.channelId) ??
        []) {
        listener(message);
      }
      return;
    }

    if (parsed?.type === "chat.notification" && parsed.data) {
      const notification = normalizeChatNotification(
        parsed.data as ChatNotification,
      );
      for (const listener of this.chatNotificationListeners) {
        listener(notification);
      }
      return;
    }

    if (parsed?.type === "team.notification" && parsed.data) {
      const notification = normalizeTeamNotification(
        parsed.data as TeamNotification,
      );
      for (const listener of this.teamNotificationListeners) {
        listener(notification);
      }
      return;
    }

    if (
      parsed?.type === "chat.presence" &&
      typeof parsed.onlineCount === "number"
    ) {
      for (const listener of this.chatPresenceListeners) {
        listener(parsed.onlineCount);
      }
      return;
    }

    if (parsed?.type === "tape.snapshot" && parsed.data && typeof parsed.data.symbol === "string" && typeof parsed.data.exchange === "string") {
      const entry = this.tapeListeners.get(marketKey(parsed.data.symbol, parsed.data.exchange));
      for (const listener of entry?.listeners ?? []) listener({ type: "data", payload: parsed.data });
      return;
    }

    const scannerKind =
      typeof parsed?.type === "string"
        ? SCANNER_MESSAGE_KINDS[parsed.type]
        : undefined;
    if (scannerKind) {
      const { type: _type, ...payload } = parsed;
      this.emitScannerEvent(scannerKind, { type: "data", payload });
      return;
    }

    if (parsed?.type === "scanner.denied") {
      const denied = SCANNER_MESSAGE_KINDS[`scanner.${parsed.scanner}`];
      if (denied) {
        this.emitScannerEvent(denied, {
          type: "denied",
          reason:
            typeof parsed.reason === "string" ? parsed.reason : "pro_required",
        });
      }
      return;
    }

    if (
      parsed?.type === "market.quote" &&
      parsed.quote &&
      typeof parsed.symbol === "string"
    ) {
      const key = marketKey(parsed.symbol, parsed.exchange);
      const quote: CloudQuotePayload = {
        ...(parsed.quote as CloudQuotePayload),
        ...(parsed.delivery === "stream" || parsed.delivery === "poll"
          ? { delivery: parsed.delivery }
          : {}),
        ...(typeof parsed.stale === "boolean" ? { stale: parsed.stale } : {}),
      };
      for (const subscription of this.quoteSubscriptions.get(key)?.values() ??
        []) {
        subscription.listener(subscription.target, quote);
      }
      return;
    }

    if (typeof parsed?.type === "string") {
      const listeners = this.cloudEventListeners.get(parsed.type);
      if (listeners && listeners.size > 0) {
        for (const listener of listeners) {
          listener(parsed.data);
        }
        return;
      }
    }
  }

  private getWebSocketBaseUrl(): string {
    const baseUrl = this.delegate.getBaseUrl();
    const wsProtocol = baseUrl.startsWith("https") ? "wss" : "ws";
    return baseUrl.replace(/^https?/, wsProtocol);
  }

  private emitScannerEvent(
    scanner: ScannerKind,
    event: ScannerFeedEvent,
  ): void {
    this.scannerSnapshots.set(scanner, event);
    for (const listener of this.scannerListeners.get(scanner) ?? []) {
      listener(event);
    }
  }

  private shouldKeepSocketOpen(): boolean {
    if (this.quoteTargets.size > 0 || this.scannerListeners.size > 0 || this.tapeListeners.size > 0)
      return true;
    return (
      this.delegate.hasSessionCredential() &&
      this.delegate.hasVerifiedUser() &&
      (this.channelListeners.size > 0 ||
        this.teamNotificationListeners.size > 0 ||
        this.cloudEventListeners.size > 0)
    );
  }

  private ensureSocket(): void {
    if (!this.shouldKeepSocketOpen() || this.ws || this.reconnectTimer) return;

    const socketToken = this.delegate.getSocketAuthToken();
    const usingWebSocketToken = this.delegate.isUsingWebSocketToken();
    const url = socketToken
      ? `${this.getWebSocketBaseUrl()}/cloud/ws?token=${encodeURIComponent(socketToken)}`
      : `${this.getWebSocketBaseUrl()}/cloud/ws`;
    cloudApiLog.info("open websocket", {
      hasToken: !!socketToken,
      tokenSource: usingWebSocketToken ? "websocket" : "session",
      quoteTargets: this.quoteTargets.size,
      channelTargets: this.channelListeners.size,
    });
    this.health.reportSocketState(
      GLOOM_CLOUD_SOCKET_CONNECTION_ID,
      "connecting",
      this.getWebSocketBaseUrl(),
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      cloudApiLog.info("websocket open");
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "open",
        this.getWebSocketBaseUrl(),
      );
      this.reconnectDelayMs = 1000;
      this.flushSubscriptions();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      void this.handleSocketMessage(String(event.data));
    };

    ws.onclose = (event) => {
      const activeSocket = this.ws === ws;
      if (this.ws === ws) {
        this.ws = null;
      this.emitTapeStatus({ type: "disconnected", reason: "Stream disconnected; observed window may contain gaps" });
      }
      const closeEvent = event as CloseEvent | undefined;
      cloudApiLog.warn("websocket closed", {
        quoteTargets: this.quoteTargets.size,
        channelTargets: this.channelListeners.size,
        code: closeEvent?.code,
        reason: closeEvent?.reason,
        tokenSource: usingWebSocketToken ? "websocket" : "session",
      });
      if (!activeSocket) return;
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "closed",
        closeEvent?.reason ||
          (closeEvent?.code ? `Closed (${closeEvent.code})` : "Socket closed"),
      );
      if (
        usingWebSocketToken &&
        this.delegate.clearWebSocketTokenForFallback()
      ) {
        this.reconnectDelayMs = 1000;
        cloudApiLog.warn(
          "cleared websocket token after socket close; falling back to session token",
        );
      }
      if (!this.shouldKeepSocketOpen()) return;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "error",
        "WebSocket error",
      );
      // Reconnect is handled by onclose.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldKeepSocketOpen()) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
      this.ensureSocket();
    }, delay);
  }

  private sendSocketMessage(payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (
      payload &&
      typeof payload === "object" &&
      "type" in (payload as Record<string, unknown>)
    ) {
      const type = (payload as Record<string, unknown>).type;
      if (
        type === "market.subscribe" ||
        type === "market.unsubscribe" ||
        type === "chat.subscribe" ||
        type === "chat.unsubscribe" ||
        type === "scanner.subscribe" ||
        type === "scanner.unsubscribe"
      ) {
        cloudApiLog.info("send websocket message", payload);
      }
    }
    this.ws.send(JSON.stringify(payload));
  }

  private flushSubscriptions(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    for (const channelId of this.channelListeners.keys()) {
      this.sendSocketMessage({ type: "chat.subscribe", channelId });
    }

    for (const entry of this.tapeListeners.values()) {
      this.sendSocketMessage({ type: "tape.subscribe", symbol: entry.symbol, exchange: entry.exchange });
    }

    for (const scanner of this.scannerListeners.keys()) {
      this.sendSocketMessage({ type: "scanner.subscribe", scanner });
    }

    if (this.quoteTargets.size > 0) {
      this.sendSocketMessage({
        type: "market.subscribe",
        symbols: [...this.quoteTargets.values()].map((target) =>
          this.serializeQuoteStreamTarget(target),
        ),
      });
    }
  }

  private scheduleQuoteSubscriptionFlush(): void {
    if (this.quoteSubscriptionFlushTimer) return;
    this.quoteSubscriptionFlushTimer = setTimeout(() => {
      this.quoteSubscriptionFlushTimer = null;
      this.flushQueuedQuoteSubscriptions();
    }, QUOTE_SUBSCRIPTION_FLUSH_MS);
  }

  private queueQuoteSubscribes(targets: QuoteStreamTarget[]): void {
    for (const target of targets) {
      const key = marketKey(target.symbol, target.exchange);
      this.pendingQuoteUnsubscribes.delete(key);
      this.pendingQuoteSubscribes.set(key, target);
    }
    this.scheduleQuoteSubscriptionFlush();
  }

  private queueQuoteUnsubscribes(targets: QuoteStreamTarget[]): void {
    for (const target of targets) {
      const key = marketKey(target.symbol, target.exchange);
      this.pendingQuoteSubscribes.delete(key);
      this.pendingQuoteUnsubscribes.set(key, target);
    }
    this.scheduleQuoteSubscriptionFlush();
  }

  private flushQueuedQuoteSubscriptions(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.pendingQuoteSubscribes.clear();
      this.pendingQuoteUnsubscribes.clear();
      return;
    }
    const subscribes = [...this.pendingQuoteSubscribes.values()];
    const unsubscribes = [...this.pendingQuoteUnsubscribes.values()];
    this.pendingQuoteSubscribes.clear();
    this.pendingQuoteUnsubscribes.clear();
    if (unsubscribes.length > 0) {
      this.sendSocketMessage({
        type: "market.unsubscribe",
        symbols: unsubscribes.map((target) =>
          this.serializeQuoteStreamTarget(target),
        ),
      });
    }
    if (subscribes.length > 0) {
      this.sendSocketMessage({
        type: "market.subscribe",
        symbols: subscribes.map((target) =>
          this.serializeQuoteStreamTarget(target),
        ),
      });
    }
  }

  private serializeQuoteStreamTarget(
    target: QuoteStreamTarget,
  ): QuoteStreamTarget {
    return {
      symbol: target.symbol,
      exchange: target.exchange ?? "",
      ...(target.surface ? { surface: target.surface } : {}),
      ...(target.visible ? { visible: true } : {}),
      ...(target.selected ? { selected: true } : {}),
      ...(Number.isFinite(target.weight) ? { weight: target.weight } : {}),
    };
  }

  private areQuoteStreamTargetsEquivalent(
    left: QuoteStreamTarget,
    right: QuoteStreamTarget,
  ): boolean {
    return (
      JSON.stringify(this.serializeQuoteStreamTarget(left)) ===
      JSON.stringify(this.serializeQuoteStreamTarget(right))
    );
  }
}
