import type { CheckResult } from "./results";

interface Member { pid: number; created: bigint }
interface Listener extends Member { address: string; port: number }
interface Membership { assigned: number; pids: number[] }

const CLEANUP_ID = "as-shipped-cleanup";
const PROFILE_RETRY_DELAYS = [250, 500, 1_000, 2_000, 4_000];

export class PortSampleError extends Error {}

/** Decode the aligned MIB_TCPTABLE_OWNER_MODULE / MIB_TCP6TABLE_OWNER_MODULE rows. */
export function decodeListeners(table: Buffer, family: 4 | 6): Listener[] {
  const stride = family === 4 ? 160 : 192;
  if (table.length < 4) throw new PortSampleError(`Malformed IPv${family} listener table`);
  const count = table.readUInt32LE(0);
  if (count && 8 + count * stride > table.length) throw new PortSampleError(`Truncated IPv${family} listener table`);
  return Array.from({ length: count }, (_, index) => {
    const row = 8 + index * stride;
    const state = table.readUInt32LE(row + (family === 4 ? 0 : 48));
    const pid = table.readUInt32LE(row + (family === 4 ? 20 : 52));
    const port = table.readUInt16BE(row + (family === 4 ? 8 : 20));
    if (state !== 2 || !port) throw new PortSampleError(`Malformed IPv${family} listener row`);
    const created = table.readBigUInt64LE(row + (family === 4 ? 24 : 56));
    if (family === 4) return { pid, created, port, address: table.subarray(row + 4, row + 8).join(".") };
    const words = Array.from({ length: 8 }, (_, word) => table.readUInt16BE(row + 2 * word).toString(16));
    const address = new URL(`http://[${words.join(":")}]`).hostname.slice(1, -1);
    const scope = table.readUInt32BE(row + 16);
    return { pid, created, port, address: scope ? `${address}%${scope}` : address };
  });
}

/** The enclosing job, not the nominal parent PID, is the provenance of a process. */
export function attributeListeners(before: Membership, members: Member[], listeners: Listener[], after: Membership) {
  const owners = new Map(members.map(({ pid, created }) => [pid, created]));
  const pids = new Set(before.pids);
  const remaining = new Set(after.pids);
  if (before.assigned !== after.assigned || pids.size !== remaining.size || before.pids.some((pid) => !remaining.has(pid))) {
    throw new PortSampleError("Launch membership changed during the listener sample");
  }
  if (pids.size !== members.length || before.pids.some((pid) => !owners.get(pid))) {
    throw new PortSampleError("Missing creation identity for a launch member");
  }
  return listeners.flatMap(({ pid, created, address, port }) => {
    if (!pid) throw new PortSampleError("A listener has no owning process ID");
    const ownerCreated = owners.get(pid);
    if (ownerCreated === undefined) return [];
    if (!created) throw new PortSampleError("A listener with a launch member's PID has no bind time");
    return created >= ownerCreated ? [{ address, port }] : [];
  });
}

export function isAsShippedCheck(id: string): boolean {
  return id === "listens-locally" || id === "no-devtools-port" || id === CLEANUP_ID;
}

export function portResults(sample: ReturnType<typeof attributeListeners> | string, shots: string[], ms: number): CheckResult[] {
  const error = typeof sample === "string" ? sample : !sample.length ? "Found no listening socket owned by the isolated launch" : null;
  const sockets = typeof sample === "string" ? [] : sample;
  const open = sockets.filter(({ address }) => address !== "127.0.0.1" && address !== "::1");
  const devtools = sockets.filter(({ port }) => port >= 9222 && port <= 9232);
  const list = (rows: typeof sockets) => rows.map(({ address, port }) => `${address.includes(":") ? `[${address}]` : address}:${port}`).join(", ");
  return [
    {
      id: "listens-locally",
      title: "As shipped, it listens only on this machine",
      status: error || open.length ? "fail" : "pass",
      detail: error ?? `${open.length ? `${open.length} on every interface or the network; ` : ""}listening on ${list(sockets)}`,
      shots, ms, data: { sockets },
    },
    {
      id: "no-devtools-port",
      title: "As shipped, no DevTools port",
      status: error || devtools.length ? "fail" : "pass",
      detail: error ?? (devtools.length ? `DevTools on ${list(devtools)}` : "none in 9222-9232"),
      shots: [], ms: 0,
    },
  ];
}

function profileRemovalCategory(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  switch (code) {
    case "EACCES": case "EPERM": return "access denied";
    case "EBUSY": return "profile busy";
    case "ENOTEMPTY": case "ENOENT": return "profile changed during removal";
    case "EMFILE": case "ENFILE": return "file handle limit";
    default: return "filesystem error";
  }
}

/** Wait for the isolated job to stop before touching its profile. */
export async function cleanupPortLaunch(
  stop: (() => Promise<void>) | undefined,
  removeProfile: (() => Promise<void>) | undefined,
  pause: (ms: number) => Promise<void> = Bun.sleep,
): Promise<CheckResult> {
  const started = performance.now();
  const result = (status: "pass" | "fail", detail: string): CheckResult => ({
    id: CLEANUP_ID, title: "As shipped, isolated launch cleanup", status, detail, shots: [], ms: Math.round(performance.now() - started),
  });
  try {
    await stop?.();
  } catch {
    return result("fail", "Launch shutdown unconfirmed; profile removal was not attempted");
  }
  if (!removeProfile) return result("pass", "No profile was created");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeProfile();
      return result("pass", "Removed the isolated profile");
    } catch (error) {
      const delay = PROFILE_RETRY_DELAYS[attempt];
      if (delay === undefined) return result("fail", `Could not remove the isolated profile (${profileRemovalCategory(error)})`);
      await pause(delay);
    }
  }
}
