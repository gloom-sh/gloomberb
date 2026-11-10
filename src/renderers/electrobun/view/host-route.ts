import { CONNECTION_LOST_MESSAGE, RpcTimeoutError } from "../../../utils/rpc-timeout-error";

/** WebSocket's `readyState` values, by index. */
const SOCKET_STATES = ["connecting", "open", "closing", "closed"] as const;
const CONNECTING = 0;
const OPEN = 1;

/**
 * How long a request waits for a way to the Bun process when the page has
 * none, and how long Electroview's socket may stay connecting before what
 * waits on it goes through the native bridge instead.
 */
const HOST_ROUTE_LIMIT_MS = 5_000;
const POLL_MS = 25;

/** What the route reads of Electroview's socket to the Bun process, and closes. */
export interface HostSocket {
  readonly readyState: number;
  close(): void;
}

export interface HostRouteOptions {
  /** Electroview's socket, which it opens once, as the page loads, and never again. */
  socket: () => HostSocket | undefined;
  /** Whether the page has the native message bridge Electroview sends through whenever its socket is not open. */
  nativeBridge: () => boolean;
  limitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (callback: () => void, ms: number) => void;
}

/**
 * The way a desktop window's requests reach the app's Bun process.
 *
 * Electroview sends over its loopback socket while that is open, holds what
 * is sent while it connects, and otherwise hands each message to the page's
 * native bridge (on Windows the Bun process answers by running a script in
 * the page whatever the socket does). The socket is opened once and never
 * reopened, so once anything closes it the native bridge carries the
 * window's requests from then on, while the Bun process's answers and pushed
 * quotes keep arriving. A request therefore waits only when the page has
 * neither, and fails with a plain "Connection lost" once that has lasted
 * `limitMs`.
 *
 * Electrobun starts a request's timer only once the message is sent, so one
 * held behind a socket that never opens would wait forever. A socket still
 * connecting `limitMs` after a request first found it so is closed, and
 * Electroview's close handler sends what it held through the native bridge.
 */
export function createHostRoute(options: HostRouteOptions): { ready(method: string): Promise<void> } {
  const limitMs = options.limitMs ?? HOST_ROUTE_LIMIT_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => { setTimeout(callback, ms); });
  const watched = new WeakSet<HostSocket>();

  const closeIfNeverOpens = (socket: HostSocket) => {
    if (watched.has(socket)) return;
    watched.add(socket);
    setTimer(() => {
      if (socket.readyState === CONNECTING) socket.close();
    }, limitMs);
  };

  return {
    async ready(method: string): Promise<void> {
      const startedAt = now();
      for (;;) {
        const socket = options.socket();
        const state = socket?.readyState;
        if (state === OPEN) return;
        if (options.nativeBridge()) {
          if (socket && state === CONNECTING) closeIfNeverOpens(socket);
          return;
        }
        const elapsedMs = now() - startedAt;
        if (elapsedMs >= limitMs) {
          const socketState = state === undefined ? "missing" : SOCKET_STATES[state] ?? String(state);
          throw new RpcTimeoutError(CONNECTION_LOST_MESSAGE, {
            elapsedMs,
            limitMs,
            report: `No way to the Bun process for ${method}: socket ${socketState}, no native bridge`,
          });
        }
        await sleep(POLL_MS);
      }
    },
  };
}

/**
 * Follows whether requests across the bridge get answers. One that found no
 * way through or got no answer in time leaves the bridge failing, and the
 * next answer calls `onRecovered`, once, so what failed meanwhile is asked
 * again. An error the Bun process sent back is an answer too.
 */
export function createBridgeHealth(onRecovered: () => void): { track<T>(request: () => Promise<T>): Promise<T> } {
  let failing = false;
  const answered = () => {
    if (!failing) return;
    failing = false;
    onRecovered();
  };
  return {
    async track<T>(request: () => Promise<T>): Promise<T> {
      let result: T;
      try {
        result = await request();
      } catch (error) {
        if (error instanceof RpcTimeoutError) failing = true;
        else answered();
        throw error;
      }
      answered();
      return result;
    },
  };
}
