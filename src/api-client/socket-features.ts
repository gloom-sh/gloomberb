import { ListenerSet } from "./socket-listeners";

/**
 * Protocol features this client can read. A server lists the ones it offers
 * in "ready"; the client opts into the shared ones, so an older server never
 * sees a request it does not understand.
 */
const MARKET_BATCH_FEATURE = "market.batch";
/** Chat frames carry `attachments`; without it the server writes images into the text. */
export const CHAT_ATTACHMENTS_FEATURE = "chat.attachments";
/** The app can run terminal tools relayed from a remote assistant; it still announces itself first. */
export const TERMINAL_RELAY_FEATURE = "terminal.relay";
const CLIENT_SOCKET_FEATURES = [MARKET_BATCH_FEATURE, CHAT_ATTACHMENTS_FEATURE, TERMINAL_RELAY_FEATURE] as const;
/**
 * The server streams perpetual listings (`BTC:HYPERLIQUID`) from their venues. Until a server offers it, they are
 * kept off market.subscribe: an older one would read `BTC` on HYPERLIQUID as a stock symbol.
 */
const MARKET_PERPS_FEATURE = "market.perps";

export type SocketFeatureHooks = {
  /** Sends a frame on the open connection; nothing happens when there is none. */
  send: (payload: Record<string, unknown>) => void;
  /** The connection whose server offers perpetual markets, or null when the last hello did not offer them. */
  perpsOffered: (socket: WebSocket | null) => void;
};

/** What the server offers in its "ready" frames, and the features this client opts into on each connection. */
export class SocketFeatures {
  /** The connection that already opted into server features; a reconnect negotiates again. */
  private requestedFor: WebSocket | null = null;
  /** What the last "ready" frame offered; kept across reconnects so a blip does not hide features. */
  private offered: ReadonlySet<string> = new Set();
  private readonly listeners = new ListenerSet();

  constructor(private readonly hooks: SocketFeatureHooks) {}

  /** Whether the server's last "ready" frame offered this protocol feature. */
  offers(feature: string): boolean {
    return this.offered.has(feature);
  }

  /** Called whenever what the server offers changes. */
  subscribe(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  /** Reads a "ready" frame's offer on `socket`, the current connection, and opts into the shared features once per connection. */
  negotiate(socket: WebSocket | null, offered: unknown): void {
    this.record(socket, offered);
    if (!Array.isArray(offered) || this.requestedFor === socket) return;
    const features = CLIENT_SOCKET_FEATURES.filter((feature) => offered.includes(feature));
    if (features.length === 0) return;
    this.requestedFor = socket;
    this.hooks.send({ type: "client.features", features });
  }

  private record(socket: WebSocket | null, offered: unknown): void {
    const next = new Set(
      Array.isArray(offered)
        ? offered.filter((feature): feature is string => typeof feature === "string")
        : [],
    );
    const changed = next.size !== this.offered.size
      || [...next].some((feature) => !this.offered.has(feature));
    this.offered = next;
    // Perpetual listings held back since the socket opened go out once this connection's server offers them.
    this.hooks.perpsOffered(next.has(MARKET_PERPS_FEATURE) ? socket : null);
    if (!changed) return;
    this.listeners.emit();
  }
}
