import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createDefaultConfig } from "../src/types/config";
import { SqliteDatabase } from "../src/data/sqlite/database";
import { sendRemoteControlRequest } from "../src/remote/client";
import {
  summarizeInteractionPerformance,
  type InteractionPerformanceSample,
} from "../src/renderers/opentui/interaction-performance";

interface Options {
  command: string;
  count: number;
  expectedPaneId: string;
  intervalMs: number;
  output: string;
  width: number;
  height: number;
}

interface CachedSeriesRow {
  namespace: string;
  kind: string;
  entity_key: string;
  variant_key: string;
  source_key: string;
  schema_version: number;
  payload: string;
  provenance: string | null;
  fetched_at: number;
  stale_at: number;
  expires_at: number;
  last_accessed_at: number;
  size_bytes: number;
}

const root = resolve(import.meta.dir, "..");
const options = parseOptions(process.argv.slice(2));
const session = `gloomberb-nav-${process.pid}`;
const sandbox = await mkdtemp(join(tmpdir(), "gloomberb-nav-"));
const sandboxHome = join(sandbox, "home");
const dataDir = join(sandboxHome, ".gloomberb");
const appLog = join(sandbox, "app.log");

try {
  if (!Bun.which("tmux")) throw new Error("tmux is required for the TUI navigation benchmark.");
  await rm(options.output, { force: true });
  await seedSandbox(dataDir);
  await runTmux(["kill-session", "-t", session], false);
  await runTmux([
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    String(options.width),
    "-y",
    String(options.height),
    "-c",
    root,
    `env HOME=${shellQuote(sandboxHome)} GLOOMBERB_INTERACTION_PERF=${shellQuote(options.output)} bun src/index.tsx`,
  ]);
  await runTmux(["pipe-pane", "-o", "-t", session, `cat > ${shellQuote(appLog)}`]);

  await waitForFile(join(dataDir, "remote-control.tui.json"), 15_000);
  await Bun.sleep(500);
  await runTmux(["send-keys", "-t", session, "C-p"]);
  await Bun.sleep(100);
  await runTmux(["send-keys", "-t", session, "-l", options.command]);
  await runTmux(["send-keys", "-t", session, "Enter"]);
  await waitForPopulatedTable(dataDir, options.expectedPaneId, 15_000);
  await Bun.sleep(500);

  await sendNavigation("Down", 2, 35);
  await sendNavigation("Up", 2, 35);
  await Bun.sleep(250);
  await sendNavigation("Down", options.count, options.intervalMs);
  await Bun.sleep(250);
  await sendNavigation("Up", options.count, options.intervalMs);
  await Bun.sleep(500);

  await runTmux(["send-keys", "-t", session, "C-c"]);
  await waitForFile(options.output, 3_000);

  const report = JSON.parse(await readFile(options.output, "utf8")) as {
    samples: InteractionPerformanceSample[];
  };
  const allNavigationSamples = report.samples
    .filter((sample) => sample.key === "up" || sample.key === "down");
  const expectedSampleCount = options.count * 2 + 4;
  if (allNavigationSamples.length !== expectedSampleCount) {
    throw new Error(
      `Expected ${expectedSampleCount} framed navigation inputs, received ${allNavigationSamples.length}.`,
    );
  }
  const navigation = allNavigationSamples.slice(4);
  const navigationFrames = [...new Map(
    navigation.map((sample) => [sample.frameId, sample]),
  ).values()];
  if (navigationFrames.every((sample) => sample.cellsUpdated === 0)) {
    throw new Error("Navigation inputs produced no rendered cell updates.");
  }
  const summary = summarizeInteractionPerformance(navigation);
  const peakRssBytes = navigationFrames.reduce(
    (maximum, sample) => Math.max(maximum, sample.rssBytes),
    0,
  );
  const cells = navigationFrames
    .map((sample) => sample.cellsUpdated)
    .sort((left, right) => left - right);
  const medianCellsUpdated = cells.length === 0
    ? 0
    : cells.length % 2 === 0
      ? (cells[cells.length / 2 - 1]! + cells[cells.length / 2]!) / 2
      : cells[Math.floor(cells.length / 2)]!;
  console.log(JSON.stringify({
    command: options.command,
    dimensions: { width: options.width, height: options.height },
    intervalMs: options.intervalMs,
    medianCellsUpdated,
    output: options.output,
    peakRssMiB: Math.round((peakRssBytes / 1024 / 1024) * 10) / 10,
    summary,
  }, null, 2));
} finally {
  await runTmux(["kill-session", "-t", session], false);
  await rm(sandbox, { recursive: true, force: true });
}

async function sendNavigation(key: "Up" | "Down", count: number, intervalMs: number) {
  for (let index = 0; index < count; index += 1) {
    await runTmux(["send-keys", "-t", session, key]);
    if (index < count - 1) await Bun.sleep(intervalMs);
  }
}

async function seedSandbox(targetDataDir: string): Promise<void> {
  await mkdir(targetDataDir, { recursive: true });
  const config = {
    ...createDefaultConfig(targetDataDir),
    onboardingComplete: true,
  };
  await writeFile(join(targetDataDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const target = new SqliteDatabase(join(targetDataDir, ".gloomberb-cache.db"));
  try {
    const sourcePath = await currentDatabasePath();
    if (!sourcePath || !existsSync(sourcePath)) return;
    const source = new Database(sourcePath, { readonly: true });
    try {
      const rows = source.query(`
        SELECT namespace, kind, entity_key, variant_key, source_key,
               schema_version, payload, provenance, fetched_at, stale_at,
               expires_at, last_accessed_at, size_bytes
        FROM resource_cache
        WHERE kind = 'econ-statistics-series'
      `).all() as CachedSeriesRow[];
      const insert = target.connection.prepare(`
        INSERT OR REPLACE INTO resource_cache (
          namespace, kind, entity_key, variant_key, source_key,
          schema_version, payload, provenance, fetched_at, stale_at,
          expires_at, last_accessed_at, size_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      target.connection.transaction((entries: typeof rows) => {
        for (const row of entries) {
          insert.run(
            row.namespace,
            row.kind,
            row.entity_key,
            row.variant_key,
            row.source_key,
            row.schema_version,
            row.payload,
            row.provenance,
            row.fetched_at,
            row.stale_at,
            row.expires_at,
            row.last_accessed_at,
            row.size_bytes,
          );
        }
      })(rows);
    } finally {
      source.close();
    }
  } finally {
    target.close();
  }
}

async function currentDatabasePath(): Promise<string | null> {
  const home = process.env.HOME;
  if (!home) return null;
  try {
    const globalConfig = JSON.parse(await readFile(join(home, ".gloomberb", "config.json"), "utf8")) as {
      dataDir?: string;
    };
    return join(globalConfig.dataDir || join(home, ".gloomberb"), ".gloomberb-cache.db");
  } catch {
    return join(home, ".gloomberb", ".gloomberb-cache.db");
  }
}

async function runTmux(args: string[], check = true): Promise<void> {
  const process = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (check && exitCode !== 0) {
    throw new Error(`tmux ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Benchmark report was not written: ${path}`);
}

async function waitForPopulatedTable(
  targetDataDir: string,
  expectedPaneId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendRemoteControlRequest(
        { type: "get", resource: "app://snapshot" },
        { dataDir: targetDataDir, appKind: "tui" },
      );
      if (response.ok && response.data && typeof response.data === "object") {
        const snapshot = response.data as {
          app?: { commandBarOpen?: unknown; focusedPaneId?: unknown };
          panes?: Array<{ instanceId?: unknown; paneId?: unknown; focused?: unknown }>;
          ui?: Array<{
            role?: unknown;
            metadata?: { paneInstanceId?: unknown; rowCount?: unknown };
          }>;
        };
        const focusedPane = snapshot.panes?.find((pane) => (
          pane.focused === true
          || pane.instanceId === snapshot.app?.focusedPaneId
        ));
        const hasPopulatedTable = snapshot.ui?.some((node) => {
          const metadata = node.metadata;
          if (!metadata) return false;
          return node.role === "table"
            && metadata.paneInstanceId === focusedPane?.instanceId
            && typeof metadata.rowCount === "number"
            && metadata.rowCount > 1;
        });
        if (
          snapshot.app?.commandBarOpen === false
          && focusedPane?.paneId === expectedPaneId
          && hasPopulatedTable
        ) return;
      }
    } catch {
      // The app may still be replacing its command-bar surface.
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `Command ${options.command} did not focus pane ${expectedPaneId} with a populated table.`,
  );
}

function parseOptions(args: string[]): Options {
  const output = takeOption(args, "--output")
    ?? join(tmpdir(), `gloomberb-navigation-${Date.now()}.json`);
  const command = takeOption(args, "--command") ?? "ECST";
  const expectedPaneId = takeOption(args, "--pane-id")
    ?? (command.trim().split(/\s+/, 1)[0]?.toUpperCase() === "ECST" ? "econ-statistics" : null);
  if (!expectedPaneId) {
    throw new Error("--pane-id is required when benchmarking a command other than ECST.");
  }
  return {
    command,
    count: positiveInteger(
      takeOption(args, "--count") ?? takeOption(args, "--keys"),
      12,
      "count",
    ),
    expectedPaneId,
    intervalMs: positiveInteger(
      takeOption(args, "--interval") ?? takeOption(args, "--interval-ms"),
      25,
      "interval",
    ),
    output: resolve(output),
    width: positiveInteger(takeOption(args, "--width"), 140, "width"),
    height: positiveInteger(takeOption(args, "--height"), 45, "height"),
  };
}

function takeOption(args: string[], name: string): string | undefined {
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
