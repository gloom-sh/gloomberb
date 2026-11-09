import type { ShotApiSocketCall, ShotApiSocketRead, ShotApiSocketReply, ShotMarketSocketCall } from "../../../cli/desktop-pane-shot-routes";

/** Reads the page has on its socket at once; the rest wait for a reply, as fetch's six connections made them wait. */
const SHOT_SOCKET_MAX_IN_FLIGHT = 16;
/** How long a read waits for its reply on the socket before it is made over HTTP instead. */
const SHOT_SOCKET_CALL_TIMEOUT_MS = 20_000;

/**
 * Sends a read over the socket. Resolves to null when the socket cannot carry
 * it (closed before or while it waited, or no reply in time): the caller makes
 * it over HTTP then. Null at once when the socket has closed.
 */
export type ShotApiSocketSend = (
  call: Omit<ShotApiSocketRead, "id"> | Omit<ShotMarketSocketCall, "id">,
  signal: AbortSignal | null | undefined,
) => Promise<Response | null> | null;

/** The part of a browser WebSocket the page's calls use. */
export interface ShotSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

function abortError(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function replyResponse(reply: Exclude<ShotApiSocketReply, { error: string }>): Response {
  const bytes = Uint8Array.from(atob(reply.body), (char) => char.charCodeAt(0));
  const empty = bytes.length === 0 || reply.status === 204 || reply.status === 304;
  return new Response(empty ? null : bytes, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
}

/**
 * Cloud API and asset-data reads over one socket to the Bun server, answered
 * as each lands. A page's fetches share six connections to its origin, so a
 * board's seventy contract histories and terms waited on each other for
 * seconds. At most `limit` reads are on the socket at once and each waits
 * `timeoutMs` for its reply. When the socket closes (the server closes it
 * when a reply cannot be sent), every read on it or waiting for it goes over
 * HTTP, as every later one does. Null when the socket does not open.
 */
export function openShotApiSocket(
  connect: () => ShotSocket,
  { limit = SHOT_SOCKET_MAX_IN_FLIGHT, timeoutMs = SHOT_SOCKET_CALL_TIMEOUT_MS } = {},
): Promise<ShotApiSocketSend | null> {
  return new Promise((resolve) => {
    const pending = new Map<number, (reply: ShotApiSocketReply | null) => void>();
    const waiting: Array<() => void> = [];
    let nextId = 1;
    let open = false;
    let socket: ShotSocket;
    try {
      socket = connect();
    } catch {
      // Intentional fallback: a page that cannot open the socket makes every read over HTTP.
      resolve(null);
      return;
    }
    const startNext = () => {
      while (waiting.length && pending.size < limit) waiting.shift()!();
    };
    socket.addEventListener("message", (event) => {
      let reply: ShotApiSocketReply;
      try {
        reply = JSON.parse(String(event.data)) as ShotApiSocketReply;
      } catch {
        // Intentional ignore: every reply the server sends is JSON; anything else answers no call.
        return;
      }
      pending.get(reply.id)?.(reply);
    });
    socket.addEventListener("close", () => {
      open = false;
      for (const settle of [...pending.values()]) settle(null);
      // Reads still waiting for a place start, find the socket closed and go over HTTP.
      while (waiting.length) waiting.shift()!();
      resolve(null);
    }, { once: true });
    socket.addEventListener("open", () => {
      open = true;
      resolve((call, signal) => !open ? null : new Promise<Response | null>((answer, fail) => {
        if (signal?.aborted) return fail(abortError(signal));
        let queued: (() => void) | null = null;
        const onAbort = () => {
          if (queued) waiting.splice(waiting.indexOf(queued), 1);
          fail(abortError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const start = () => {
          queued = null;
          if (signal?.aborted) return;
          if (!open) {
            signal?.removeEventListener("abort", onAbort);
            return answer(null);
          }
          const id = nextId++;
          const settle = (reply: ShotApiSocketReply | null) => {
            if (!pending.delete(id)) return;
            clearTimeout(timer);
            signal?.removeEventListener("abort", aborted);
            startNext();
            // No reply (the socket closed, or none in time) is a read HTTP makes instead.
            if (!reply) return answer(null);
            if ("error" in reply) return fail(new TypeError(reply.error));
            answer(replyResponse(reply));
          };
          const aborted = () => {
            if (!pending.delete(id)) return;
            clearTimeout(timer);
            startNext();
            fail(abortError(signal));
          };
          signal?.removeEventListener("abort", onAbort);
          signal?.addEventListener("abort", aborted, { once: true });
          const timer = setTimeout(() => settle(null), timeoutMs);
          pending.set(id, settle);
          try {
            socket.send(JSON.stringify({ id, ...call } satisfies ShotApiSocketCall));
          } catch {
            // Intentional fallback: a socket that will not take the read is closed, and its reads go over HTTP.
            socket.close();
            settle(null);
          }
        };
        if (pending.size < limit) return start();
        queued = start;
        waiting.push(start);
      }));
    }, { once: true });
  });
}
