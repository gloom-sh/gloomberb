import type { RemoteAppKind, RemoteControlRequest, RemoteControlResponse, RemoteEndpoint } from "./types";
import { currentPidNamespace, inNestedPidNamespace, readRemoteEndpoint, removeRemoteEndpointFiles } from "./endpoint";
import { isNetworkFailure } from "../utils/network-failure";

export interface SendRemoteControlRequestOptions {
  dataDir: string;
  appKind?: RemoteAppKind;
}

const APP_NAMES: Record<RemoteAppKind, string> = { tui: "terminal", desktop: "desktop" };
/** How long the app's health answer may take before it counts as unreachable; a busy app still answers well within it. */
const HEALTH_TIMEOUT_MS = 5_000;

/** Why no app took the request, with what to do about it in `details`. `code` is what `--json` reports. */
export class RemoteAppError extends Error {
  readonly code: string;
  readonly details: string;

  constructor(code: string, message: string, details: string) {
    super(message);
    this.name = "RemoteAppError";
    this.code = code;
    this.details = details;
  }
}

/**
 * No app of this profile runs: none was started, or the one that wrote the
 * endpoint file has exited without a clean quit (its terminal closed, it was
 * killed). Says how to start one.
 */
export class RemoteAppNotRunningError extends RemoteAppError {
  constructor(appKind?: RemoteAppKind, otherKind?: RemoteAppKind) {
    super(
      "app_not_running",
      appKind ? `The Gloom ${APP_NAMES[appKind]} app is not running.` : "No Gloom app is running.",
      otherKind
        ? `The ${APP_NAMES[otherKind]} app is: pass --app ${otherKind}, or leave --app out.`
        : appKind === "desktop"
          ? "Open the Gloom desktop app, then try again."
          : appKind === "tui"
            ? "Start it with `gloom` in another terminal, then try again."
            : "Start one with `gloom` in another terminal or open the desktop app, then try again.",
    );
    this.name = "RemoteAppNotRunningError";
  }
}

/** Both apps run and neither is the one last started: the caller names which. */
export class RemoteAppAmbiguousError extends RemoteAppError {
  constructor() {
    super("app_ambiguous", "The Gloom terminal and desktop apps are both running.", "Pass --app tui or --app desktop.");
    this.name = "RemoteAppAmbiguousError";
  }
}

/**
 * An endpoint file names an app this process cannot reach, and nothing proves
 * the app gone: a sandbox that blocks localhost or hides other processes looks
 * the same from inside as an app that quit. The file is kept.
 */
export class RemoteAppUnreachableError extends RemoteAppError {
  constructor(endpoint: RemoteEndpoint, foreign: boolean) {
    const address = `127.0.0.1:${endpoint.port}, where its endpoint file says it listens`;
    super(
      "app_unreachable",
      `The Gloom ${APP_NAMES[endpoint.appKind] ?? "app"} app could not be reached.`,
      `${foreign ? `What answers at ${address}, is not Gloom.` : `Nothing answered at ${address}.`} `
        + "If this command runs in a sandbox, let it reach 127.0.0.1 or run it outside the sandbox. "
        + "If Gloom has quit, start it again: the new app replaces the file.",
    );
    this.name = "RemoteAppUnreachableError";
  }
}

/** Whether an endpoint's app is there: true, false, or null when this process cannot tell. */
function processAlive(endpoint: RemoteEndpoint): boolean | null {
  // A process id is only meaningful in the namespace that issued it.
  const own = currentPidNamespace();
  const comparable = endpoint.pidNamespace !== undefined
    ? endpoint.pidNamespace === own
    // A file from an app that did not name its namespace: doubt the ids only inside a sandbox's or container's own.
    : !inNestedPidNamespace();
  if (!comparable || !Number.isInteger(endpoint.pid) || endpoint.pid <= 0) return null;
  try {
    process.kill(endpoint.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // One owned by another user, or that a sandbox will not let this process signal, still runs.
    return code === "ESRCH" ? false : code === "EPERM" ? true : null;
  }
}

function connectionRefused(error: unknown): boolean {
  const codes = [error, (error as { cause?: unknown } | null)?.cause]
    .map((entry) => (entry as { code?: unknown } | null | undefined)?.code);
  return codes.includes("ConnectionRefused") || codes.includes("ECONNREFUSED");
}

/** Gloom answered; the port refused; the connection failed some other way (a sandbox, a timeout); something else answered. */
type Health = "gloom" | "refused" | "failed" | "foreign";

/** Asks the endpoint's port, without the token, whether a Gloom app answers there. */
async function probeHealth(endpoint: RemoteEndpoint): Promise<Health> {
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = await response.json().catch(() => {
      // Intentional ignore: an answer that is not JSON is not Gloom's, which the null below says.
      return null;
    }) as { ok?: unknown } | null;
    return response.ok && body?.ok === true ? "gloom" : "foreign";
  } catch (error) {
    return connectionRefused(error) ? "refused" : "failed";
  }
}

type EndpointState =
  | { kind: "running"; endpoint: RemoteEndpoint }
  | { kind: "unreachable"; endpoint: RemoteEndpoint; foreign: boolean }
  | { kind: "gone" };

/** Reads the endpoint files and probes each app once, however many files name it. */
function endpointReader(dataDir: string) {
  const states = new Map<string, Promise<EndpointState>>();

  const classify = async (endpoint: RemoteEndpoint): Promise<EndpointState> => {
    const health = await probeHealth(endpoint);
    if (health === "gloom") return { kind: "running", endpoint };
    // Only proof on both counts removes the file: the app's process is gone, and its port refuses.
    if (health === "refused" && processAlive(endpoint) === false) {
      await removeRemoteEndpointFiles(dataDir, endpoint).catch(() => { /* Intentional ignore: a file another process removed or replaced first is not ours to clean. */ });
      return { kind: "gone" };
    }
    return { kind: "unreachable", endpoint, foreign: health === "foreign" };
  };

  return async (appKind?: RemoteAppKind): Promise<EndpointState> => {
    let endpoint: RemoteEndpoint;
    try {
      endpoint = await readRemoteEndpoint(dataDir, appKind);
    } catch {
      // Intentional ignore: a file that is absent, or cut short by an app that died writing it, names no app to reach.
      return { kind: "gone" };
    }
    const key = `${endpoint.pid}:${endpoint.port}:${endpoint.token}`;
    let state = states.get(key);
    if (!state) states.set(key, state = classify(endpoint));
    return state;
  };
}

function unreachable(state: Extract<EndpointState, { kind: "unreachable" }>): RemoteAppUnreachableError {
  return new RemoteAppUnreachableError(state.endpoint, state.foreign);
}

/**
 * The running app to send to: the one asked for, else the one started last
 * (`remote-control.json`), else the only one of the two still running. An
 * endpoint file is removed only when its process is gone and its port refuses.
 */
export async function resolveRemoteEndpoint(dataDir: string, appKind?: RemoteAppKind): Promise<RemoteEndpoint> {
  const read = endpointReader(dataDir);
  if (appKind) {
    const state = await read(appKind);
    if (state.kind === "running") return state.endpoint;
    if (state.kind === "unreachable") throw unreachable(state);
    const other: RemoteAppKind = appKind === "tui" ? "desktop" : "tui";
    throw new RemoteAppNotRunningError(appKind, (await read(other)).kind === "running" ? other : undefined);
  }
  const latest = await read();
  if (latest.kind === "running") return latest.endpoint;
  const states = await Promise.all([read("tui"), read("desktop")]);
  const running = states.filter((state) => state.kind === "running");
  if (running.length > 1) throw new RemoteAppAmbiguousError();
  if (running[0]) return running[0].endpoint;
  const blocked = [latest, ...states].find((state) => state.kind === "unreachable");
  if (blocked) throw unreachable(blocked);
  throw new RemoteAppNotRunningError();
}

export async function sendRemoteControlRequest(
  request: RemoteControlRequest,
  options: SendRemoteControlRequestOptions,
): Promise<RemoteControlResponse> {
  const endpoint = await resolveRemoteEndpoint(options.dataDir, options.appKind);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    // It answered its health check a moment ago; the next call finds out whether it quit.
    if (!isNetworkFailure(error)) throw error;
    throw new RemoteAppUnreachableError(endpoint, false);
  }
  const payload = await response.json() as RemoteControlResponse;
  if (!response.ok && payload.ok !== false) {
    return {
      ok: false,
      error: {
        code: "remote_http_error",
        message: `Remote control request failed with HTTP ${response.status}.`,
        details: payload,
      },
    };
  }
  return payload;
}
