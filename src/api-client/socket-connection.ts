import { logFailure } from "../utils/log-failure";
import { debugLog, previewLongLists } from "../utils/debug-log";
import {
  GLOOM_CLOUD_SOCKET_CONNECTION_ID,
  type ConnectionHealthRegistry,
} from "../core/connection-health";

/** How long a connection may take to open before the attempt is dropped and tried again. */
export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
/**
 * An open connection that has sent nothing for this long is asked whether it
 * is still there: a `ping`, which the server answers with a `pong`.
 */
export const SOCKET_QUIET_PING_MS = 10_000;
/**
 * A connection that has not answered a ping in this long, nothing else come
 * back meanwhile, is taken for dead (a half-open link: a laptop that slept, a
 * network that changed under it). It is dropped and opened again; until then
 * prices it streamed read as stale. Only an unanswered ping drops it: silence
 * alone does not, since a check that runs late (a hidden tab's throttled
 * timers, a wake from sleep) finds any connection silent.
 */
export const SOCKET_PING_ANSWER_MS = 10_000;
/** How often an open connection's silence is checked; it never needs to be exact. */
const SOCKET_SILENCE_CHECK_MS = 2_500;
/** The first reconnect waits about this long; each failure doubles it, up to RECONNECT_MAX_DELAY_MS. */
const RECONNECT_FIRST_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10_000;
/**
 * Each reconnect waits its delay times a random factor in this range: the
 * first one 0.25 to 2.25 s. A server restart or a proxy reload drops every
 * client in the same second; spread over two seconds, their reconnects do
 * not arrive as one burst. The first one still lands inside the quote
 * stream's grace (QUOTE_STREAM_DOWN_GRACE_MS), so nothing reads as stale.
 */
const RECONNECT_JITTER_MIN = 0.25;
const RECONNECT_JITTER_SPAN = 2;
/** The longest the first reconnect after a drop waits. */
export const SOCKET_FIRST_RECONNECT_MAX_MS = RECONNECT_FIRST_DELAY_MS * (RECONNECT_JITTER_MIN + RECONNECT_JITTER_SPAN);
/** Outgoing frames worth a debug log line: the subscription changes. */
const LOGGED_FRAME_TYPES = new Set<unknown>([
  "market.subscribe",
  "market.unsubscribe",
  "chat.subscribe",
  "chat.unsubscribe",
  "scanner.subscribe",
  "scanner.unsubscribe",
]);
const cloudApiLog = debugLog.createLogger("cloud-api");

/** What opening a connection needs from the signed-in session. */
export type SocketConnectionSession = {
  getBaseUrl: () => string;
  getSocketAuthToken: () => string | null;
  isUsingWebSocketToken: () => boolean;
  clearWebSocketTokenForFallback: () => boolean;
  /** The service answered on this connection (it opened, or sent a frame). */
  onServiceAnswered?: () => void;
};

/** What the connection asks of its owner, and tells it. */
export type SocketConnectionOwner = {
  /** Whether anything still needs a connection: asked before one opens and before each reconnect. */
  wanted: () => boolean;
  /** The subscription counts the debug log lines carry. */
  logCounts: () => { quoteTargets: number; channelTargets: number };
  /** The connection opened. */
  opened: () => void;
  /** One frame from the current connection. */
  received: (raw: string) => void;
  /** The current connection broke off by itself (closed, or dropped unanswered), so streams may have gaps. */
  interrupted: () => void;
  /** The current connection ended, however it did. */
  closed: () => void;
};

/**
 * The one WebSocket to Gloom Cloud: opening it, watching that it still answers, and reconnecting with backoff while
 * its owner wants it. It reports every state to the connection health registry.
 */
export class SocketConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_FIRST_DELAY_MS;
  /** Gives up on a connection that has not opened in SOCKET_CONNECT_TIMEOUT_MS. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Checks the open connection's silence (SOCKET_QUIET_PING_MS, SOCKET_PING_ANSWER_MS). */
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  /** When the open connection last sent anything, and when the ping still unanswered went out. */
  private lastFrameAt = 0;
  private pingedAt: number | null = null;

  constructor(
    private readonly session: SocketConnectionSession,
    private readonly health: ConnectionHealthRegistry,
    private readonly owner: SocketConnectionOwner,
  ) {}

  /** The current connection, open or still opening. */
  get socket(): WebSocket | null {
    return this.ws;
  }

  /** The current connection while it is open, null otherwise. */
  openSocket(): WebSocket | null {
    return this.ws?.readyState === WebSocket.OPEN ? this.ws : null;
  }

  /** The next reconnect waits the shortest delay again. */
  resetBackoff(): void {
    this.reconnectDelayMs = RECONNECT_FIRST_DELAY_MS;
  }

  /** Sends one frame on the open connection; false when there is none or the send fails. */
  sendFrame(payload: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      logFailure("cloud-socket", "WebSocket frame send failed")(error);
      return false;
    }
  }

  /** Sends one frame on the open connection; nothing happens when there is none. */
  send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (LOGGED_FRAME_TYPES.has(payload.type)) {
      cloudApiLog.info("send websocket message", previewLongLists(payload));
    }
    this.ws.send(JSON.stringify(payload));
  }

  /** Opens a connection when the owner wants one and none is open, opening, or waiting to reconnect. */
  ensureOpen(): void {
    if (!this.owner.wanted() || this.ws || this.reconnectTimer) return;

    const socketBaseUrl = this.getWebSocketBaseUrl();
    if (!socketBaseUrl) {
      this.failOpen(`Not a usable Gloom Cloud URL: ${this.session.getBaseUrl()}`);
      return;
    }

    const socketToken = this.session.getSocketAuthToken();
    const usingWebSocketToken = this.session.isUsingWebSocketToken();
    const url = socketToken
      ? `${socketBaseUrl}/cloud/ws?token=${encodeURIComponent(socketToken)}`
      : `${socketBaseUrl}/cloud/ws`;
    cloudApiLog.info("open websocket", {
      hasToken: !!socketToken,
      tokenSource: usingWebSocketToken ? "websocket" : "session",
      ...this.owner.logCounts(),
    });
    this.health.reportSocketState(
      GLOOM_CLOUD_SOCKET_CONNECTION_ID,
      "connecting",
      socketBaseUrl,
    );
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.failOpen(error instanceof Error ? error.message : String(error));
      return;
    }
    this.ws = ws;
    let opened = false;
    // A link that swallows the handshake never says so: the attempt is dropped and tried again.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.ws === ws) this.dropUnanswered(ws, "Connecting timed out");
    }, SOCKET_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.watchSilence();
      this.session.onServiceAnswered?.();
      cloudApiLog.info("websocket open");
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "open",
        socketBaseUrl,
      );
      this.reconnectDelayMs = RECONNECT_FIRST_DELAY_MS;
      this.owner.opened();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      this.pingedAt = null;
      this.session.onServiceAnswered?.();
      this.owner.received(String(event.data));
    };

    ws.onclose = (event) => {
      const activeSocket = this.ws === ws;
      if (activeSocket) {
        this.ws = null;
        this.stopWatching();
        this.owner.interrupted();
      }
      const closeEvent = event as CloseEvent | undefined;
      cloudApiLog.warn("websocket closed", {
        ...this.owner.logCounts(),
        code: closeEvent?.code,
        reason: closeEvent?.reason,
        tokenSource: usingWebSocketToken ? "websocket" : "session",
      });
      if (!activeSocket) return;
      this.owner.closed();
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "closed",
        closeEvent?.reason ||
          (closeEvent?.code ? `Closed (${closeEvent.code})` : "Socket closed"),
      );
      if (
        usingWebSocketToken &&
        this.session.clearWebSocketTokenForFallback()
      ) {
        this.reconnectDelayMs = RECONNECT_FIRST_DELAY_MS;
        cloudApiLog.warn(
          "cleared websocket token after socket close; falling back to session token",
        );
      }
      if (!this.owner.wanted()) return;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // A socket that was open, cut by a server restart or a proxy, fires its
      // error just before its close: the close reports it, so the stream gets
      // the grace a clean close does. One that never opened is a failed
      // connect, and one open but silent is dropped by the ping check.
      if (opened) return;
      this.health.reportSocketState(
        GLOOM_CLOUD_SOCKET_CONNECTION_ID,
        "error",
        "WebSocket error",
      );
      // Reconnect is handled by onclose.
    };
  }

  /** Closes the connection from this side and cancels a reconnect still waiting. */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatching();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this.owner.closed();
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
      // Intentional ignore: Closing an already closed socket needs no further cleanup.
    }
  }

  /** Opens a connection again after the backoff, unless one is already waiting or the owner no longer wants one. */
  scheduleReconnect(): void {
    if (this.reconnectTimer || !this.owner.wanted()) return;
    // Jittered so clients dropped together by a server restart do not all
    // come back in the same instant.
    const delay = Math.round(this.reconnectDelayMs * (RECONNECT_JITTER_MIN + RECONNECT_JITTER_SPAN * Math.random()));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
      this.ensureOpen();
    }, delay);
  }

  /**
   * The ws(s) form of the API base URL, or null when the base is not an
   * http(s) URL. The web build derives it from `location.origin`, which is the
   * string "null" on an opaque page, and `null/api` must not become a socket URL.
   */
  private getWebSocketBaseUrl(): string | null {
    const baseUrl = this.session.getBaseUrl();
    if (!/^https?:\/\//.test(baseUrl)) return null;
    const wsProtocol = baseUrl.startsWith("https") ? "wss" : "ws";
    return baseUrl.replace(/^https?/, wsProtocol);
  }

  /** From the open: the connection's silence is checked until it closes. */
  private watchSilence(): void {
    this.stopWatching();
    this.lastFrameAt = Date.now();
    this.pingedAt = null;
    this.silenceTimer = setInterval(() => this.checkSilence(), SOCKET_SILENCE_CHECK_MS);
  }

  private stopWatching(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.connectTimer = null;
    this.silenceTimer = null;
  }

  /**
   * A connection that went quiet is pinged; one that leaves the ping
   * unanswered for SOCKET_PING_ANSWER_MS is half open, and is dropped and
   * opened again. Anything it sends answers the ping.
   */
  private checkSilence(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this.pingedAt != null) {
      if (now - this.pingedAt >= SOCKET_PING_ANSWER_MS) this.dropUnanswered(ws, "No answer from the stream");
      return;
    }
    if (now - this.lastFrameAt >= SOCKET_QUIET_PING_MS) {
      this.pingedAt = now;
      this.sendFrame({ type: "ping" });
    }
  }

  /**
   * Gives up on a connection that never opened or went silent: what it was
   * carrying is reported as interrupted (the stream's health turns to error,
   * which marks its prices stale), and a new one is opened with the backoff.
   * Its close, if it ever comes, is for a socket no longer in use.
   */
  private dropUnanswered(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopWatching();
    cloudApiLog.warn("websocket unanswered; reconnecting", { reason, quoteTargets: this.owner.logCounts().quoteTargets });
    try {
      ws.close();
    } catch {
      // Intentional ignore: a socket that cannot close is dropped all the same.
    }
    this.owner.interrupted();
    this.owner.closed();
    this.health.reportSocketState(GLOOM_CLOUD_SOCKET_CONNECTION_ID, "error", reason);
    this.scheduleReconnect();
  }

  /**
   * A socket that could not be constructed is an error to show, not to throw:
   * ensureOpen runs from effects and timers nobody awaits. The reconnect
   * backoff retries it, so a URL that never works settles at the slowest delay.
   */
  private failOpen(reason: string): void {
    // The reason can carry the socket URL with its token, so only the health detail keeps it.
    cloudApiLog.warn("websocket could not be opened");
    this.health.reportSocketState(GLOOM_CLOUD_SOCKET_CONNECTION_ID, "error", reason);
    this.scheduleReconnect();
  }
}
