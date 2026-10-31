import { readFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { makePrivateDir, writePrivateFile } from "../utils/private-files";
import type { RemoteAppKind, RemoteEndpoint } from "./types";

const DEFAULT_ENDPOINT_FILE = "remote-control.json";

export function remoteEndpointPath(dataDir: string, appKind?: RemoteAppKind): string {
  return join(dataDir, appKind ? `remote-control.${appKind}.json` : DEFAULT_ENDPOINT_FILE);
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

/** Readable by the user alone, an older copy included: it holds the token that controls the app. */
async function writeRemoteEndpoint(filePath: string, endpoint: RemoteEndpoint): Promise<void> {
  await makePrivateDir(dirname(filePath));
  await writePrivateFile(filePath, JSON.stringify(endpoint, null, 2));
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
