import type { CloudApiSocket } from "../api-client/socket";
import type { AuthUser } from "../api-client/types";

export const verifiedUser: AuthUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  username: "test",
  emailVerified: true,
  image: null,
  createdAt: "2026-03-30T00:00:00.000Z",
  updatedAt: "2026-03-30T00:00:00.000Z",
};

/** A socket the test drives by hand: it records what the client sends and delivers what the test receives. */
export class TestWebSocket {
  static readonly OPEN = 1;
  readyState: number;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: any[] = [];
  closeCalls = 0;

  constructor(readonly url: string, initialReadyState = 1) {
    this.readyState = initialReadyState;
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  closeWith(event: { code: number; reason: string }): void {
    this.readyState = 3;
    this.onclose?.(event);
  }
}

/**
 * Replaces globalThis.WebSocket and returns every socket the client opens, in order.
 * The suite restores the original WebSocket itself.
 */
export function installTestWebSocket(initialReadyState = 1): TestWebSocket[] {
  const sockets: TestWebSocket[] = [];
  class InstalledTestWebSocket extends TestWebSocket {
    constructor(url: string) {
      super(url, initialReadyState);
      sockets.push(this);
    }
  }
  globalThis.WebSocket = InstalledTestWebSocket as unknown as typeof WebSocket;
  return sockets;
}

type CloudApiSocketDelegate = ConstructorParameters<typeof CloudApiSocket>[0];

/** A signed-out delegate for CloudApiSocket; a test overrides only what it controls. */
export function createTestSocketDeps(overrides: Partial<CloudApiSocketDelegate> = {}): CloudApiSocketDelegate {
  return {
    getBaseUrl: () => "https://api.example.test",
    getSocketAuthToken: () => null,
    hasSessionCredential: () => false,
    hasVerifiedUser: () => false,
    isUsingWebSocketToken: () => false,
    clearWebSocketTokenForFallback: () => false,
    markCurrentUserUnverified: () => {},
    updateCurrentUserFromSocket: () => {},
    ...overrides,
  };
}
