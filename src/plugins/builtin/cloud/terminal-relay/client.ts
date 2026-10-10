import { TERMINAL_RELAY_FEATURE } from "../../../../api-client/socket";
import type { TerminalRelayEngine } from "./engine";
import { TERMINAL_RELAY_PROTOCOL, terminalRelayToolDescriptors } from "./manifest";

/** What the relay needs from the Cloud socket (apiClient in the app, a fake in tests). */
export interface TerminalRelaySocket {
  subscribeConnection(listener: (event: "ready" | "closed") => void): () => void;
  subscribeCloudEvent(type: string, listener: (data: unknown) => void): () => void;
  sendFrame(frame: Record<string, unknown>): boolean;
  serverOffers(feature: string): boolean;
}

export interface TerminalDeviceIdentity {
  id: string;
  kind: "desktop" | "tui";
  name: string;
  appVersion: string;
}

const ACTIVITY_INTERVAL_MS = 30_000;
const RELAY_FRAMES = ["terminal.call", "terminal.cancel", "terminal.revoke"] as const;

/**
 * Announces this app on the Cloud socket after each server hello and hands
 * relayed frames to the engine. An older server never offers the relay, so
 * the app never announces itself there.
 */
export class TerminalRelayClient {
  private announced = false;
  private lastActivityAt = 0;

  constructor(
    private readonly socket: TerminalRelaySocket,
    private readonly engine: TerminalRelayEngine,
    private readonly device: () => TerminalDeviceIdentity | null,
    private readonly now: () => number = Date.now,
  ) {}

  start(): () => void {
    const unsubscribers = [
      this.socket.subscribeConnection((event) => {
        if (event === "ready") this.announce();
        else this.lost();
      }),
      ...RELAY_FRAMES.map((type) => this.socket.subscribeCloudEvent(type, (data) => {
        if (this.announced) this.engine.receive(type, data);
      })),
    ];
    // The socket may already be up when the relay starts.
    this.announce();
    return () => {
      if (this.announced) this.socket.sendFrame({ type: "terminal.bye" });
      this.lost();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  /**
   * The session changed: announce once signed in, say goodbye once signed
   * out, without waiting for the socket to reconnect.
   */
  refresh(): void {
    if (this.announced && !this.device()) {
      this.socket.sendFrame({ type: "terminal.bye" });
      this.lost();
    } else if (!this.announced) {
      this.announce();
    }
  }

  /** The person used the app; Gloom Cloud picks the most recently used terminal by default. */
  activity(): void {
    if (!this.announced || this.now() - this.lastActivityAt < ACTIVITY_INTERVAL_MS) return;
    if (this.socket.sendFrame({ type: "terminal.active" })) this.lastActivityAt = this.now();
  }

  private announce(): void {
    if (!this.socket.serverOffers(TERMINAL_RELAY_FEATURE)) return;
    const device = this.device();
    if (!device) return;
    this.engine.connected();
    this.announced = this.socket.sendFrame({
      type: "terminal.hello",
      device: {
        ...device,
        protocol: TERMINAL_RELAY_PROTOCOL,
        tools: terminalRelayToolDescriptors(),
      },
    });
    this.lastActivityAt = this.now();
  }

  private lost(): void {
    this.announced = false;
    this.engine.disconnected();
  }
}
