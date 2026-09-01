import { mkdir, open, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface ClientLockMetadata {
  pid: number;
  ownerToken: string;
  requestedClientId: number;
  clientId: number;
  host: string;
  port: number;
  instanceId?: string;
  cwd: string;
  timestamp: number;
}

export interface ClaimedClientLock {
  clientId: number;
  requestedClientId: number;
  path: string;
}

interface ClientLockConnection {
  host: string;
  port: number;
}

const IBKR_CLIENT_LOCK_DIR = join(tmpdir(), "gloomberb-ibkr-client-locks");
const IBKR_CLIENT_ID_SEARCH_SPAN = 64;

function buildClientLockPath(config: ClientLockConnection, clientId: number): string {
  const host = (config.host || "localhost").replace(/[^a-z0-9_.-]+/gi, "_");
  return join(IBKR_CLIENT_LOCK_DIR, `${host}-${config.port}-${clientId}.lock`);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readClientLock(path: string): Promise<ClientLockMetadata | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ClientLockMetadata>;
    if (
      typeof parsed.pid !== "number"
      || typeof parsed.ownerToken !== "string"
      || typeof parsed.clientId !== "number"
      || typeof parsed.requestedClientId !== "number"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      ownerToken: parsed.ownerToken,
      clientId: parsed.clientId,
      requestedClientId: parsed.requestedClientId,
      host: typeof parsed.host === "string" ? parsed.host : "",
      port: typeof parsed.port === "number" ? parsed.port : 0,
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
    };
  } catch {
    return null;
  }
}

export class IbkrClientLockManager {
  private readonly ownerToken = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  private claimedLock: ClaimedClientLock | null = null;

  constructor(private readonly instanceId?: string) {}

  get activeClaim(): ClaimedClientLock | null {
    return this.claimedLock;
  }

  getClientIdCandidates(requestedClientId: number): number[] {
    const preferred = this.claimedLock?.clientId;
    const candidates = new Set<number>();
    if (preferred && Number.isFinite(preferred) && preferred > 0) {
      candidates.add(preferred);
    }
    for (let offset = 0; offset < IBKR_CLIENT_ID_SEARCH_SPAN; offset += 1) {
      candidates.add(requestedClientId + offset);
    }
    return [...candidates];
  }

  async tryClaim(
    config: ClientLockConnection,
    clientId: number,
    requestedClientId: number,
  ): Promise<boolean> {
    const path = buildClientLockPath(config, clientId);
    const existing = this.claimedLock;
    if (
      existing
      && existing.clientId === clientId
      && existing.requestedClientId === requestedClientId
    ) {
      return true;
    }

    await mkdir(IBKR_CLIENT_LOCK_DIR, { recursive: true });
    const metadata: ClientLockMetadata = {
      pid: process.pid,
      ownerToken: this.ownerToken,
      requestedClientId,
      clientId,
      host: config.host,
      port: config.port,
      instanceId: this.instanceId,
      cwd: process.cwd(),
      timestamp: Date.now(),
    };

    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify(metadata), "utf-8");
      await handle.close();
      await this.release();
      this.claimedLock = { clientId, requestedClientId, path };
      return true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const lock = await readClientLock(path);
    if (!lock || !isProcessAlive(lock.pid)) {
      await rm(path, { force: true }).catch(() => {});
      return this.tryClaim(config, clientId, requestedClientId);
    }
    if (lock.ownerToken === this.ownerToken) {
      await this.release();
      this.claimedLock = { clientId, requestedClientId, path };
      return true;
    }
    return false;
  }

  async release(): Promise<void> {
    const lock = this.claimedLock;
    this.claimedLock = null;
    if (!lock) return;
    await rm(lock.path, { force: true }).catch(() => {});
  }
}
