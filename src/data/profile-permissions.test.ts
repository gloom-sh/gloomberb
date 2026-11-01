import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDataDir } from "./config/store/node";
import { SqliteDatabase } from "./sqlite/database";
import { writeRemoteEndpointFiles } from "../remote/endpoint";
import { saveDesktopViewIds } from "../renderers/electrobun/bun/desktop/view-ids";
import { createNodeStallReporterHost } from "../telemetry/stall-reports-node";
import type { RemoteEndpoint } from "../remote/types";

const scratch: string[] = [];
const keys = ["HOME", "GLOOMBERB_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** A file as an older install, or a loose umask, left it: readable by everyone. */
function shared(path: string, contents = "{}"): string {
  writeFileSync(path, contents);
  chmodSync(path, 0o644);
  return path;
}

// The profile holds broker credentials (config.json), the Cloud session (the database), a token that controls
// the app and logs of what the user did; on a shared machine none of it may be readable by another account.
describe.skipIf(process.platform === "win32")("profile permissions", () => {
  test("a new profile is created private, and an older one is tightened at startup", async () => {
    const root = tempDir("gloom-profile-");
    const fresh = join(root, "fresh");
    process.env.GLOOMBERB_HOME = fresh;
    await initDataDir(fresh);
    expect(modeOf(fresh)).toBe(0o700);
    expect(modeOf(join(fresh, "config.json"))).toBe(0o600);

    const older = join(root, "older");
    mkdirSync(older, { mode: 0o755 });
    chmodSync(older, 0o755);
    process.env.GLOOMBERB_HOME = older;
    const files = [
      shared(join(older, "config.json"), JSON.stringify({ dataDir: older, onboardingComplete: true })),
      shared(join(older, ".gloomberb-cache.db"), ""),
      shared(join(older, ".gloomberb-cache.db-wal"), ""),
      shared(join(older, "stall-log.txt"), "stall\n"),
      shared(join(older, "stall-reports.json")),
      shared(join(older, "crash-reports.json"), "[]"),
      shared(join(older, "desktop-view-ids.json")),
      shared(join(older, "remote-control.json")),
      shared(join(older, "remote-control.tui.json")),
    ];
    const note = shared(join(older, "notes.md"), "# mine");
    expect((await initDataDir(older)).onboardingComplete).toBe(true);
    expect(modeOf(older)).toBe(0o700);
    expect(files.filter((file) => modeOf(file) !== 0o600)).toEqual([]);
    // Only what holds credentials, the session, the token or logs.
    expect(modeOf(note)).toBe(0o644);

    if (process.platform === "linux") {
      // The XDG layout keeps config.json in a folder of its own.
      const home = tempDir("gloom-user-");
      delete process.env.GLOOMBERB_HOME;
      process.env.HOME = home;
      for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const) delete process.env[key];
      const configDir = join(home, ".config", "gloomberb");
      mkdirSync(configDir, { recursive: true, mode: 0o755 });
      chmodSync(configDir, 0o755);
      const data = join(home, ".local", "share", "gloomberb");
      shared(join(configDir, "config.json"), JSON.stringify({ dataDir: data }));
      await initDataDir(data);
      expect([modeOf(configDir), modeOf(join(configDir, "config.json")), modeOf(data)]).toEqual([0o700, 0o600, 0o700]);
    }
  });

  test("the database, the remote-control endpoint, the view ids and the stall log are the user's alone after every write", async () => {
    const dataDir = tempDir("gloom-profile-");
    const dbPath = join(dataDir, ".gloomberb-cache.db");
    new SqliteDatabase(dbPath).close();
    chmodSync(dbPath, 0o644);
    const database = new SqliteDatabase(dbPath);
    database.connection.exec("INSERT INTO plugin_state VALUES ('p', 'k', 1, 'v', 0)");
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(modeOf)).toEqual([0o600, 0o600, 0o600]);
    database.close();

    const endpoint = { protocolVersion: 1, appKind: "tui", pid: 1, port: 2, token: "t" } as unknown as RemoteEndpoint;
    shared(join(dataDir, "remote-control.json"));
    await writeRemoteEndpointFiles(dataDir, endpoint);
    expect([modeOf(join(dataDir, "remote-control.json")), modeOf(join(dataDir, "remote-control.tui.json"))]).toEqual([0o600, 0o600]);

    saveDesktopViewIds(dataDir, { "gloomberb.view": "abc" });
    expect(modeOf(join(dataDir, "desktop-view-ids.json"))).toBe(0o600);

    const stallLog = shared(join(dataDir, "stall-log.txt"), "older stall\n");
    const stallState = shared(join(dataDir, "stall-reports.json"));
    const stalls = createNodeStallReporterHost({ getDataDir: () => dataDir });
    stalls.appendLog("a stall");
    stalls.save({ sent: {}, pending: {}, recent: {} });
    expect([modeOf(stallLog), modeOf(stallState)]).toEqual([0o600, 0o600]);
  });
});
