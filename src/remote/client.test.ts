import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "http";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { currentPidNamespace, remoteEndpointPath, writeRemoteEndpointFiles } from "./endpoint";
import {
  RemoteAppAmbiguousError,
  RemoteAppNotRunningError,
  RemoteAppUnreachableError,
  resolveRemoteEndpoint,
  sendRemoteControlRequest,
} from "./client";
import { REMOTE_CONTROL_PROTOCOL_VERSION, type RemoteAppKind, type RemoteEndpoint } from "./types";

/** A process id that was a process a moment ago and is not one now. */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""]);
  await child.exited;
  return child.pid;
}

/** A local port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return typeof address === "object" && address ? address.port : 1;
}

/** A port that answers as a running app does: its health without a token, and the token it was given on /rpc. */
async function listeningApp(token: string, seen: string[] = [], gloom = true): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? "no token"}`);
    if (!gloom) {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }
    response.writeHead(request.url === "/health" || request.headers.authorization === `Bearer ${token}` ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: "answered" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 1,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function endpoint(appKind: RemoteAppKind, pid: number, port: number, pidNamespace = currentPidNamespace()): RemoteEndpoint {
  return {
    protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
    appKind,
    pid,
    port,
    token: `token-${appKind}-${pid}`,
    startedAt: new Date().toISOString(),
    ...(pidNamespace ? { pidNamespace } : {}),
  };
}

const exists = (path: string) => Bun.file(path).exists();

describe("finding the running app", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const dataDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloom-remote-client-"));
    tempDirs.push(dir);
    return dir;
  };

  test("an app that exited without quitting is not running, and its endpoint files are removed", async () => {
    const dir = await dataDir();
    await writeRemoteEndpointFiles(dir, endpoint("tui", await exitedPid(), await closedPort()));

    const error = await resolveRemoteEndpoint(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteAppNotRunningError);
    expect((error as Error).message).toBe("No Gloom app is running.");
    expect(await exists(remoteEndpointPath(dir))).toBe(false);
    expect(await exists(remoteEndpointPath(dir, "tui"))).toBe(false);

    // Asked for by kind, it says which app and how to start it.
    await writeRemoteEndpointFiles(dir, endpoint("tui", await exitedPid(), await closedPort()));
    await expect(resolveRemoteEndpoint(dir, "tui")).rejects.toMatchObject({
      message: "The Gloom terminal app is not running.",
      details: expect.stringContaining("`gloom`"),
    });
  });

  test("the last app started is gone: the one still running answers, and --app for the gone one names it", async () => {
    const dir = await dataDir();
    const app = await listeningApp(`token-desktop-${process.pid}`);
    try {
      const desktop = endpoint("desktop", process.pid, app.port);
      await writeRemoteEndpointFiles(dir, desktop);
      // The terminal app started later, so it wrote remote-control.json, and was killed.
      await writeRemoteEndpointFiles(dir, endpoint("tui", await exitedPid(), await closedPort()));

      expect(await resolveRemoteEndpoint(dir)).toEqual(desktop);
      expect(await exists(remoteEndpointPath(dir))).toBe(false);
      expect(await exists(remoteEndpointPath(dir, "desktop"))).toBe(true);
      await expect(resolveRemoteEndpoint(dir, "tui")).rejects.toMatchObject({
        message: "The Gloom terminal app is not running.",
        details: "The desktop app is: pass --app desktop, or leave --app out.",
      });

      // Two running apps, neither the one remote-control.json names: the caller picks.
      await writeRemoteEndpointFiles(dir, { ...endpoint("tui", process.pid, app.port), token: "token-tui" });
      await rm(remoteEndpointPath(dir));
      await expect(resolveRemoteEndpoint(dir)).rejects.toBeInstanceOf(RemoteAppAmbiguousError);
    } finally {
      await app.close();
    }
  });

  test("the token goes only to a port whose health answers, after it does", async () => {
    const dir = await dataDir();
    const seen: string[] = [];
    const app = await listeningApp(`token-tui-${process.pid}`, seen);
    try {
      await writeRemoteEndpointFiles(dir, endpoint("tui", process.pid, app.port));
      expect(await sendRemoteControlRequest({ type: "help" }, { dataDir: dir })).toEqual({ ok: true, data: "answered" });
      expect(seen).toEqual(["GET /health no token", `POST /rpc Bearer token-tui-${process.pid}`]);
    } finally {
      await app.close();
    }

    // Another server took the port: it never gets the token, and the file stays for the app to replace.
    const other: string[] = [];
    const server = await listeningApp("unused", other, false);
    try {
      await writeRemoteEndpointFiles(dir, endpoint("tui", process.pid, server.port));
      await expect(sendRemoteControlRequest({ type: "help" }, { dataDir: dir })).rejects.toMatchObject({
        code: "app_unreachable",
        details: expect.stringContaining("is not Gloom"),
      });
      expect(other).toEqual(["GET /health no token"]);
    } finally {
      await server.close();
    }
  });

  test("a refused port with the app's process still there, or out of sight, keeps the file and says it could not be reached", async () => {
    const dir = await dataDir();
    // A sandbox that blocks localhost, or a process id reused after the app exited: from here they look the same.
    await writeRemoteEndpointFiles(dir, endpoint("tui", process.pid, await closedPort()));
    const error = await sendRemoteControlRequest({ type: "help" }, { dataDir: dir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteAppUnreachableError);
    expect(error).toMatchObject({ code: "app_unreachable", message: "The Gloom terminal app could not be reached." });
    expect((error as RemoteAppUnreachableError).details).toContain("sandbox");
    expect(await exists(remoteEndpointPath(dir))).toBe(true);
    expect(await exists(remoteEndpointPath(dir, "tui"))).toBe(true);

    // A process id from another namespace (a sandbox's own) says nothing, even when no process has it here.
    await writeRemoteEndpointFiles(dir, endpoint("desktop", await exitedPid(), await closedPort(), "pid:[1]"));
    await expect(resolveRemoteEndpoint(dir, "desktop")).rejects.toBeInstanceOf(RemoteAppUnreachableError);
    expect(await exists(remoteEndpointPath(dir, "desktop"))).toBe(true);
  });
});
