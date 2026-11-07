import { readFileSync, readlinkSync } from "fs";
import { readFile, rename, rm } from "fs/promises";
import { dirname, join } from "path";
import { makePrivateDir, writePrivateFile } from "../utils/private-files";
import type { RemoteAppKind, RemoteEndpoint } from "./types";

const DEFAULT_ENDPOINT_FILE = "remote-control.json";

export function remoteEndpointPath(dataDir: string, appKind?: RemoteAppKind): string {
  return join(dataDir, appKind ? `remote-control.${appKind}.json` : DEFAULT_ENDPOINT_FILE);
}

/** This process's process-id namespace on Linux (`pid:[4026531836]`); undefined elsewhere, where there are none. */
export function currentPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    // Intentional ignore: without /proc the namespace is unknown, and the caller treats it as such.
    return undefined;
  }
}

/** Whether this process runs in a process-id namespace nested in another, as a sandbox's or a container's. */
export function inNestedPidNamespace(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const line = /^NSpid:\s*(.+)$/m.exec(readFileSync("/proc/self/status", "utf-8"))?.[1];
    return !!line && line.trim().split(/\s+/).length > 1;
  } catch {
    // Intentional ignore: without /proc nothing says this process is nested, so its process ids are taken as they are.
    return false;
  }
}

export async function readRemoteEndpoint(dataDir: string, appKind?: RemoteAppKind): Promise<RemoteEndpoint> {
  const raw = await readFile(remoteEndpointPath(dataDir, appKind), "utf-8");
  return JSON.parse(raw) as RemoteEndpoint;
}

export async function writeRemoteEndpointFiles(dataDir: string, endpoint: RemoteEndpoint): Promise<void> {
  await writeRemoteEndpoint(remoteEndpointPath(dataDir, endpoint.appKind), endpoint);
  await writeRemoteEndpoint(remoteEndpointPath(dataDir), endpoint);
}

export async function removeRemoteEndpointFiles(dataDir: string, endpoint: RemoteEndpoint): Promise<void> {
  await Promise.all([
    removeRemoteEndpointIfOwned(remoteEndpointPath(dataDir, endpoint.appKind), endpoint),
    removeRemoteEndpointIfOwned(remoteEndpointPath(dataDir), endpoint),
  ]);
}

/**
 * Readable by the user alone, an older copy replaced: it holds the token that
 * controls the app. Written beside it and moved into place, so a client that
 * finds the file never reads it half written.
 */
async function writeRemoteEndpoint(filePath: string, endpoint: RemoteEndpoint): Promise<void> {
  await makePrivateDir(dirname(filePath));
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writePrivateFile(temporary, JSON.stringify(endpoint, null, 2));
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function removeRemoteEndpointIfOwned(filePath: string, endpoint: RemoteEndpoint): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(filePath, "utf-8")) as RemoteEndpoint;
    if (existing.pid !== endpoint.pid || existing.token !== endpoint.token || existing.port !== endpoint.port) return;
    await rm(filePath, { force: true });
  } catch {
    await rm(filePath, { force: true });
  }
}
