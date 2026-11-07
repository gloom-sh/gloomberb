import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "http";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { remoteEndpointPath, writeRemoteEndpointFiles } from "./endpoint";
import { RemoteAppAmbiguousError, RemoteAppNotRunningError, resolveRemoteEndpoint, sendRemoteControlRequest } from "./client";
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

function endpoint(appKind: RemoteAppKind, pid: number, port: number): RemoteEndpoint {
  return { protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION, appKind, pid, port, token: `token-${appKind}-${pid}`, startedAt: new Date().toISOString() };
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
    await writeRemoteEndpointFiles(dir, endpoint("tui", await exitedPid(), 1));

    const error = await resolveRemoteEndpoint(dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteAppNotRunningError);
    expect((error as Error).message).toBe("No Gloom app is running.");
    expect(await exists(remoteEndpointPath(dir))).toBe(false);
    expect(await exists(remoteEndpointPath(dir, "tui"))).toBe(false);

    // Asked for by kind, it says which app and how to start it.
    await writeRemoteEndpointFiles(dir, endpoint("tui", await exitedPid(), 1));
    await expect(resolveRemoteEndpoint(dir, "tui")).rejects.toMatchObject({
      message: "The Gloom terminal app is not running.",
      details: expect.stringContaining("`gloom`"),
    });
  });

  test("the last app started is gone: the one still running answers, and --app for the gone one names it", async () => {
    const dir = await dataDir();
    const desktop = endpoint("desktop", process.pid, 1);
    await writeRemoteEndpointFiles(dir, desktop);
    // The terminal app started later, so it wrote remote-control.json, and was killed.
    await writeRemoteEndpointFiles(dir, endpoint("tui", await exitedPid(), 2));

    expect(await resolveRemoteEndpoint(dir)).toEqual(desktop);
    expect(await exists(remoteEndpointPath(dir))).toBe(false);
    expect(await exists(remoteEndpointPath(dir, "desktop"))).toBe(true);
    await expect(resolveRemoteEndpoint(dir, "tui")).rejects.toMatchObject({
      message: "The Gloom terminal app is not running.",
      details: "The desktop app is: pass --app desktop, or leave --app out.",
    });

    // Two running apps, neither the one remote-control.json names: the caller picks.
    await writeRemoteEndpointFiles(dir, endpoint("tui", process.pid, 3));
    await rm(remoteEndpointPath(dir));
    await expect(resolveRemoteEndpoint(dir)).rejects.toBeInstanceOf(RemoteAppAmbiguousError);
  });

  test("a process id reused after the app exited: nothing listens, so it is not running and the files go", async () => {
    const dir = await dataDir();
    await writeRemoteEndpointFiles(dir, endpoint("tui", process.pid, await closedPort()));

    await expect(sendRemoteControlRequest({ type: "help" }, { dataDir: dir })).rejects.toBeInstanceOf(RemoteAppNotRunningError);
    expect(await exists(remoteEndpointPath(dir))).toBe(false);
    expect(await exists(remoteEndpointPath(dir, "tui"))).toBe(false);
  });
});
