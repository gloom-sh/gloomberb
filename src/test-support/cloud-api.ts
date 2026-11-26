import { apiClient, setCloudApiFetchTransport } from "../api-client";
import type { CloudApiSocket } from "../api-client/socket";
import type { AuthUser } from "../api-client/types";

/**
 * A request whose response replaces the session credential in its headers, as the app's own transport takes it,
 * with its body held: returns once the headers are in (and the client has had the chance to tell its listeners),
 * the body still out and no account read for the new credential. `finish` lets the body in and puts the default
 * transport back; until then any other request through the transport is answered 503. The token is the caller's
 * synthetic value.
 */
export async function replaceCredentialInResponseHeaders(token: string): Promise<{ finish: () => Promise<void> }> {
  const body = Promise.withResolvers<string>();
  let told = false;
  const stop = apiClient.subscribeCurrentUser(() => { told = true; });
  let sent = 0;
  setCloudApiFetchTransport(async () => (++sent === 1
    ? { ok: true, status: 200, headers: new Headers({ "set-cookie": `gloomberb.session_token=${token}; Path=/; HttpOnly; SameSite=Lax` }), text: () => body.promise }
    : Response.json({ message: "Not served here" }, { status: 503 })));
  const request = apiClient.getChatState();
  request.catch(() => { /* Intentional ignore: `finish` awaits it. */ });
  // A credential the same as the one in place tells nobody: wait a few turns at most.
  for (let turn = 0; turn < 20 && !told; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  let finished: Promise<void> | null = null;
  return {
    finish: () => finished ??= (async () => {
      body.resolve(JSON.stringify({ channels: [], onlineCount: 0, channelStates: [], notifications: [] }));
      try {
        await request;
      } finally {
        setCloudApiFetchTransport(null);
      }
    })(),
  };
}

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
