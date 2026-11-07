import type { RemoteAppKind, RemoteControlRequest, RemoteControlResponse, RemoteEndpoint } from "./types";
import { readRemoteEndpoint, removeRemoteEndpointFiles } from "./endpoint";
import { isNetworkFailure } from "../utils/network-failure";

export interface SendRemoteControlRequestOptions {
  dataDir: string;
  appKind?: RemoteAppKind;
}

const APP_NAMES: Record<RemoteAppKind, string> = { tui: "terminal", desktop: "desktop" };

/**
 * No app of this profile answers: none was started, or the one that wrote the
 * endpoint file has exited without a clean quit (its terminal closed, it was
 * killed). Says how to start one.
 */
export class RemoteAppNotRunningError extends Error {
  readonly code = "app_not_running";
  readonly details: string;

  constructor(appKind?: RemoteAppKind, otherKind?: RemoteAppKind) {
    super(appKind ? `The Gloom ${APP_NAMES[appKind]} app is not running.` : "No Gloom app is running.");
    this.name = "RemoteAppNotRunningError";
    this.details = otherKind
      ? `The ${APP_NAMES[otherKind]} app is: pass --app ${otherKind}, or leave --app out.`
      : appKind === "desktop"
        ? "Open the Gloom desktop app, then try again."
        : appKind === "tui"
          ? "Start it with `gloom` in another terminal, then try again."
          : "Start one with `gloom` in another terminal or open the desktop app, then try again.";
  }
}

/** Both apps run and neither is the one last started: the caller names which. */
export class RemoteAppAmbiguousError extends Error {
  readonly code = "app_ambiguous";
  readonly details = "Pass --app tui or --app desktop.";

  constructor() {
    super("The Gloom terminal and desktop apps are both running.");
    this.name = "RemoteAppAmbiguousError";
  }
}

/** Whether the process that wrote an endpoint is still there. One owned by another user still is. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The endpoint file's app, when the file is there and its process is; a file whose process is gone is removed. */
async function liveEndpoint(dataDir: string, appKind?: RemoteAppKind): Promise<RemoteEndpoint | null> {
  let endpoint: RemoteEndpoint;
  try {
    endpoint = await readRemoteEndpoint(dataDir, appKind);
  } catch {
    // Absent, or cut short by an app that died writing it: no app to reach through it.
    return null;
  }
  if (processAlive(endpoint.pid)) return endpoint;
  await forgetEndpoint(dataDir, endpoint);
  return null;
}

/** Removes the files that still name this endpoint, and no newer one an app has written since. */
async function forgetEndpoint(dataDir: string, endpoint: RemoteEndpoint): Promise<void> {
  await removeRemoteEndpointFiles(dataDir, endpoint).catch(() => { /* Intentional ignore: a file another process removed or replaced first is not ours to clean. */ });
}

/**
 * The running app to send to: the one asked for, else the one started last
 * (`remote-control.json`), else the only one of the two still running.
 */
export async function resolveRemoteEndpoint(dataDir: string, appKind?: RemoteAppKind): Promise<RemoteEndpoint> {
  if (appKind) {
    const endpoint = await liveEndpoint(dataDir, appKind);
    if (endpoint) return endpoint;
    const other: RemoteAppKind = appKind === "tui" ? "desktop" : "tui";
    throw new RemoteAppNotRunningError(appKind, await liveEndpoint(dataDir, other) ? other : undefined);
  }
  const latest = await liveEndpoint(dataDir);
  if (latest) return latest;
  const running = (await Promise.all([liveEndpoint(dataDir, "tui"), liveEndpoint(dataDir, "desktop")]))
    .filter((endpoint): endpoint is RemoteEndpoint => endpoint !== null);
  if (running.length > 1) throw new RemoteAppAmbiguousError();
  if (running[0]) return running[0];
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
    // Nothing listens where the file says: the process id was reused after the app exited.
    if (!isNetworkFailure(error)) throw error;
    await forgetEndpoint(options.dataDir, endpoint);
    throw new RemoteAppNotRunningError(options.appKind);
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
