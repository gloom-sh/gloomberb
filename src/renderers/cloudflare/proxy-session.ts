/**
 * Who may use the plugin HTTP proxy: a signed-in Gloomberb session, confirmed
 * by the API rather than by the cookie merely being present.
 *
 * Plugin panes fire requests in bursts, so a confirmed session is remembered
 * for a minute per isolate and concurrent requests share one check. A session
 * the API rejects is not remembered, so signing in again works at once. When
 * the API cannot answer, the proxy refuses rather than guessing.
 *
 * Only plain data outlives a request. A check in flight is shared with the
 * requests that arrive while it runs, but the runtime drops a promise's
 * continuations once the request that started it ends (a plugin aborting its
 * fetch is enough), so those requests wait only as long as a check can take
 * and then run their own.
 */
import { SESSION_COOKIE_NAMES } from "../../api-client/session-cookie";

type ApiFetch = (request: Request) => Promise<Response>;

/**
 * Forwarded beside the session cookie because the API reads it to decide
 * whether a check may extend the session. Leaving it off would quietly stretch
 * a "don't remember me" sign-in every time a plugin made a request.
 */
const DONT_REMEMBER_COOKIE_NAMES = ["__Secure-gloomberb.dont_remember", "gloomberb.dont_remember"];
const FORWARDED_COOKIE_NAMES = new Set<string>([...SESSION_COOKIE_NAMES, ...DONT_REMEMBER_COOKIE_NAMES]);
const SESSION_NAMES = new Set<string>(SESSION_COOKIE_NAMES);

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
/** How long past its own timeout a shared check may run before a waiter gives up on it. */
const SHARED_CHECK_GRACE_MS = 500;
/**
 * Per session, per isolate. A focused prediction-market pane alone polls about
 * 60 requests a minute, so this leaves room for a busy layout while still
 * stopping a script from turning one session into a free proxy.
 */
const DEFAULT_REQUESTS_PER_WINDOW = 300;
const DEFAULT_WINDOW_MS = 60_000;

type Verdict = "valid" | "invalid" | "unavailable";

interface PendingCheck {
  startedAt: number;
  verdict: Promise<Verdict>;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

type ProxyAdmission =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfterSeconds?: number };

export interface ProxySessionGate {
  admit(request: Request, fetchApi: ApiFetch): Promise<ProxyAdmission>;
}

export interface ProxySessionGateOptions {
  /** The API route that answers with the signed-in user, or nothing. */
  sessionUrl: string;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  requestsPerWindow?: number;
  windowMs?: number;
  checkTimeoutMs?: number;
}

const SIGN_IN: ProxyAdmission = { ok: false, status: 401, error: "Sign in to use plugin requests." };
const UNAVAILABLE: ProxyAdmission = {
  ok: false,
  status: 503,
  error: "Could not confirm your session right now. Try again shortly.",
};

/** The session cookies (and `dont_remember`) from a Cookie header, in order. */
function forwardedCookies(header: string | null): string | null {
  if (!header) return null;
  const kept: string[] = [];
  let hasSession = false;
  for (const part of header.split(";")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!FORWARDED_COOKIE_NAMES.has(name) || !pair.slice(eq + 1).trim()) continue;
    if (SESSION_NAMES.has(name)) hasSession = true;
    kept.push(pair);
  }
  return hasSession ? kept.join("; ") : null;
}

/** Cache keys are hashes so the isolate never holds a session token as a key. */
async function cacheKey(cookie: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Settles with `undefined` if `promise` has not settled within `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms), undefined);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drops expired entries once the map is full, then the oldest if it still is. */
function makeRoom<V>(map: Map<string, V>, maxEntries: number, expired: (value: V) => boolean): void {
  if (map.size < maxEntries) return;
  for (const [key, value] of map) {
    if (expired(value)) map.delete(key);
  }
  while (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * The API answers 200 with `{ user, session }` for a live session and 200 with
 * an empty body for anything else. Anything it cannot vouch for, including an
 * answer it did not mean to give, is treated as "could not check".
 */
async function checkSession(
  sessionUrl: string,
  cookie: string,
  userAgent: string | null,
  fetchApi: ApiFetch,
  timeoutMs: number,
): Promise<Verdict> {
  const headers = new Headers({ accept: "application/json", cookie });
  if (userAgent) headers.set("user-agent", userAgent);
  try {
    const response = await fetchApi(new Request(sessionUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    }));
    if (response.status === 401 || response.status === 403) return "invalid";
    if (!response.ok) return "unavailable";
    const text = await response.text();
    if (!text.trim()) return "invalid";
    const body = JSON.parse(text) as { user?: { id?: unknown } | null } | null;
    const id = body?.user?.id;
    return typeof id === "string" && id.length > 0 ? "valid" : "invalid";
  } catch {
    return "unavailable";
  }
}

/**
 * Create one per isolate (module scope in the worker), so its cache and rate
 * windows are shared by every request the isolate serves.
 */
export function createProxySessionGate(options: ProxySessionGateOptions): ProxySessionGate {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const requestsPerWindow = options.requestsPerWindow ?? DEFAULT_REQUESTS_PER_WINDOW;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const sharedWaitMs = checkTimeoutMs + SHARED_CHECK_GRACE_MS;
  /** Session key to the time its confirmation expires. */
  const confirmed = new Map<string, number>();
  const pending = new Map<string, PendingCheck>();
  const windows = new Map<string, RateWindow>();

  async function verdictFor(key: string, cookie: string, request: Request, fetchApi: ApiFetch): Promise<Verdict> {
    const at = now();
    const until = confirmed.get(key);
    if (until !== undefined && until > at) return "valid";
    confirmed.delete(key);

    const shared = pending.get(key);
    if (shared && at - shared.startedAt < sharedWaitMs) {
      const verdict = await settleWithin(shared.verdict, sharedWaitMs - (at - shared.startedAt));
      if (verdict !== undefined) return verdict;
    }

    // Registered before anything is awaited, so the rest of a burst that
    // arrives together finds this check and waits on it.
    const startedAt = now();
    const check: PendingCheck = {
      startedAt,
      verdict: checkSession(options.sessionUrl, cookie, request.headers.get("user-agent"), fetchApi, checkTimeoutMs),
    };
    pending.delete(key);
    makeRoom(pending, maxEntries, (entry) => startedAt - entry.startedAt >= sharedWaitMs);
    pending.set(key, check);

    const verdict = await check.verdict;
    if (pending.get(key) === check) pending.delete(key);
    if (verdict === "valid") {
      const settledAt = now();
      confirmed.delete(key);
      makeRoom(confirmed, maxEntries, (expiresAt) => expiresAt <= settledAt);
      confirmed.set(key, settledAt + ttlMs);
    }
    return verdict;
  }

  function withinRate(key: string): ProxyAdmission {
    const at = now();
    let window = windows.get(key);
    if (!window || at - window.startedAt >= windowMs) {
      windows.delete(key);
      makeRoom(windows, maxEntries, (entry) => at - entry.startedAt >= windowMs);
      window = { startedAt: at, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= requestsPerWindow) return { ok: true };
    return {
      ok: false,
      status: 429,
      error: "Too many plugin requests. Try again in a minute.",
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - at) / 1_000)),
    };
  }

  return {
    async admit(request, fetchApi) {
      const cookie = forwardedCookies(request.headers.get("cookie"));
      if (!cookie) return SIGN_IN;
      const key = await cacheKey(cookie);
      const verdict = await verdictFor(key, cookie, request, fetchApi);
      if (verdict === "invalid") return SIGN_IN;
      if (verdict === "unavailable") return UNAVAILABLE;
      return withinRate(key);
    },
  };
}
