import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readRemoteEndpoint, remoteEndpointPath, writeRemoteEndpointFiles } from "./endpoint";
import { sendRemoteControlRequest } from "./client";
import { startRemoteControlServer, type RemoteControlServer } from "./server";

/**
 * A process that starts a server and leaves with `process.exit` once told to,
 * never closing it: how the terminal app quits. Resolves with the endpoint it wrote.
 */
async function startAppThatQuitsWithoutClosing(dataDir: string, beforeExit?: () => Promise<void>) {
  const script = `
    import { startRemoteControlServer } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
    const server = await startRemoteControlServer({ dataDir: ${JSON.stringify(dataDir)}, appKind: "tui", handle: async () => ({ ok: true, data: null }) });
    console.log(JSON.stringify(server.endpoint));
    for await (const _ of console) process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  const endpoint = JSON.parse(new TextDecoder().decode(value));
  await beforeExit?.();
  child.stdin.write("quit\n");
  await child.stdin.end();
  expect(await child.exited).toBe(0);
  return endpoint;
}

describe("remote control server", () => {
  const tempDirs: string[] = [];
  const servers: RemoteControlServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("writes an endpoint and serves authenticated RPC requests", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloom-remote-"));
    tempDirs.push(dataDir);
    const server = await startRemoteControlServer({
      dataDir,
      appKind: "tui",
      handle: async (request) => ({ ok: true, data: { type: request.type } }),
    });
    servers.push(server);

    const defaultEndpoint = await readRemoteEndpoint(dataDir);
    const tuiEndpoint = await readRemoteEndpoint(dataDir, "tui");
    expect(defaultEndpoint.port).toBe(server.endpoint.port);
    expect(tuiEndpoint.token).toBe(server.endpoint.token);

    const response = await sendRemoteControlRequest({ type: "schema" }, { dataDir, appKind: "tui" });
    expect(response).toEqual({ ok: true, data: { type: "schema" } });
  });

  test("removes endpoint files on close", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloom-remote-"));
    tempDirs.push(dataDir);
    const server = await startRemoteControlServer({
      dataDir,
      appKind: "desktop",
      handle: async () => ({ ok: true, data: null }),
    });
    await server.close();

    expect(await Bun.file(remoteEndpointPath(dataDir)).exists()).toBe(false);
    expect(await Bun.file(remoteEndpointPath(dataDir, "desktop")).exists()).toBe(false);
  });

  // The terminal app quits through process.exit, which often comes before the tree whose cleanup closes the server is unmounted.
  test("takes its endpoint files away before it waits for the server to close", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloom-remote-"));
    tempDirs.push(dataDir);
    const server = await startRemoteControlServer({ dataDir, appKind: "tui", handle: async () => ({ ok: true, data: null }) });
    const closing = server.close();

    // A process that exits right after asking never sees the close finish.
    expect(existsSync(remoteEndpointPath(dataDir))).toBe(false);
    expect(existsSync(remoteEndpointPath(dataDir, "tui"))).toBe(false);
    await closing;
  });

  test("removes its endpoint files when the process exits without closing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloom-remote-"));
    tempDirs.push(dataDir);
    const endpoint = await startAppThatQuitsWithoutClosing(dataDir, async () => {
      expect(await Bun.file(remoteEndpointPath(dataDir)).exists()).toBe(true);
      expect(await Bun.file(remoteEndpointPath(dataDir, "tui")).exists()).toBe(true);
    });

    expect(endpoint.appKind).toBe("tui");
    expect(await Bun.file(remoteEndpointPath(dataDir)).exists()).toBe(false);
    expect(await Bun.file(remoteEndpointPath(dataDir, "tui")).exists()).toBe(false);
  });

  test("leaves the endpoint of another running app alone when it exits", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "gloom-remote-"));
    tempDirs.push(dataDir);
    const other = { protocolVersion: 1, appKind: "tui" as const, pid: process.pid, port: 1, token: "other-token", startedAt: new Date().toISOString() };
    await startAppThatQuitsWithoutClosing(dataDir, () => writeRemoteEndpointFiles(dataDir, other));

    expect(await readRemoteEndpoint(dataDir)).toMatchObject({ token: "other-token", port: 1 });
    expect(await readRemoteEndpoint(dataDir, "tui")).toMatchObject({ token: "other-token", port: 1 });
  });
});
