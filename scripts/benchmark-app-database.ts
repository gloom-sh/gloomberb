#!/usr/bin/env bun
/**
 * How long the app's database work holds the app's thread, on a cache the
 * size users have (about 100 MB, at the eviction limit), for this checkout
 * and another one (`--base`). The same seeded database and the same workload
 * run against each, alternating, each run in a process of its own: session
 * snapshot saves every second, plugin state, batches of quotes, price
 * histories, financials and filings read back by variant, and the eviction
 * the writes set off, with the WAL checkpointer running as in the app.
 *
 * Prints a table per checkout: each operation's median, 95th percentile and
 * longest time on the thread, and the event loop's longest pause, and writes
 * it to the job summary on CI.
 *
 *   bun scripts/benchmark-app-database.ts --base ../base [--seconds 45] [--runs 2] [--dir <folder>] [--out results.json]
 */
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

const SCRIPT = resolve(import.meta.path);
const HEAD = resolve(import.meta.dir, "..");
const MB = 1024 * 1024;
const KB = 1024;
const TICK_MS = 25;
/** Symbols with price histories, each in every range from two sources. */
const HISTORY_SYMBOLS = 30;
const LAG_PROBE_MS = 10;

type OpSamples = Record<string, number[]>;

interface RunResult {
  ops: OpSamples;
  /** Event-loop pauses past the probe's interval, in ms. */
  lags: number[];
  closeMs: number;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** A deterministic sequence, so both checkouts see the same reads and writes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function payloadOf(bytes: number): string {
  // JSON text of about `bytes`, not compressible: the cache stores provider responses.
  return JSON.stringify({ data: randomBytes(Math.max(1, Math.floor(bytes / 2) - 8)).toString("hex") });
}

interface SeedRow {
  kind: string;
  entityKey: string;
  variantKey: string;
  sourceKey: string;
  bytes: number;
}

/** The kinds and sizes of a cache a few months old, a little past the 100 MB eviction limit. */
function seedRows(): SeedRow[] {
  const random = seeded(7);
  const rows: SeedRow[] = [];
  const ranges = ["1d", "5d", "1m", "6m", "ytd", "1y", "5y", "all"];
  for (let symbol = 0; symbol < HISTORY_SYMBOLS; symbol += 1) {
    for (const range of ranges) {
      for (const source of ["provider:a", "provider:b"]) {
        const big = range === "all" && symbol < 6;
        rows.push({
          kind: "price-history",
          entityKey: `SYM${symbol}`,
          variantKey: `range=${range}`,
          sourceKey: source,
          bytes: big ? 1_700 * KB : Math.round((10 + random() * 90) * KB),
        });
      }
    }
  }
  for (let index = 0; index < 2_000; index += 1) {
    rows.push({ kind: "sec-filing-content", entityKey: `FILING${index}`, variantKey: "", sourceKey: "provider:a", bytes: Math.round((2 + random() * 10) * KB) });
  }
  for (let symbol = 0; symbol < 40; symbol += 1) {
    rows.push({ kind: "sec-filings", entityKey: `SYM${symbol}`, variantKey: "count=200", sourceKey: "provider:a", bytes: symbol === 0 ? Math.round(9.8 * MB) : Math.round((200 + random() * 600) * KB) });
  }
  for (let symbol = 0; symbol < 190; symbol += 1) {
    rows.push({ kind: "financials", entityKey: `SYM${symbol}`, variantKey: "", sourceKey: "provider:a", bytes: Math.round((20 + random() * 60) * KB) });
  }
  for (let symbol = 0; symbol < 195; symbol += 1) {
    rows.push({ kind: "options-chain", entityKey: `SYM${symbol % 60}`, variantKey: `expiry=${symbol}`, sourceKey: "provider:a", bytes: Math.round((20 + random() * 60) * KB) });
  }
  for (let symbol = 0; symbol < 450; symbol += 1) {
    rows.push({ kind: "quote", entityKey: `SYM${symbol}`, variantKey: "", sourceKey: "provider:a", bytes: 700 });
  }
  return rows;
}

/** The database every run starts from: the schema of this checkout, filled in one transaction. */
async function seedMaster(path: string): Promise<{ rows: number; bytes: number }> {
  const { SqliteDatabase } = await import(pathToFileURL(join(HEAD, "src/data/sqlite/database.ts")).href);
  const database = new SqliteDatabase(path);
  const connection = database.connection;
  const random = seeded(11);
  const now = Date.now();
  const rows = seedRows();
  const insert = connection.query(
    `INSERT OR REPLACE INTO resource_cache (
       namespace, kind, entity_key, variant_key, source_key, schema_version,
       payload, provenance, fetched_at, stale_at, expires_at, last_accessed_at, size_bytes
     ) VALUES ('market', ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?)`,
  );
  let bytes = 0;
  connection.transaction(() => {
    for (const row of rows) {
      const payload = payloadOf(row.bytes);
      const fetchedAt = now - Math.round(random() * 7 * 24 * 3_600_000);
      insert.run(row.kind, row.entityKey, row.variantKey, row.sourceKey, payload, fetchedAt, fetchedAt + 3_600_000, now + 30 * 24 * 3_600_000, fetchedAt + Math.round(random() * 3_600_000), payload.length);
      bytes += payload.length;
    }
  })();
  connection.query("INSERT OR REPLACE INTO session_snapshots (session_id, schema_version, value, updated_at) VALUES ('app', 1, ?, ?)").run(JSON.stringify(sessionSnapshot(0)), now);
  database.close();
  return { rows: rows.length, bytes };
}

/** About 85 KB, the size of a workspace with a few dozen panes and tickers. */
function sessionSnapshot(revision: number) {
  const random = seeded(revision + 1);
  return {
    revision,
    focusedPaneId: `pane-${revision % 40}`,
    paneState: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`pane-${index}`, {
      cursor: Math.floor(random() * 500),
      scroll: Math.floor(random() * 5_000),
      columns: Array.from({ length: 12 }, (_, column) => ({ id: `column-${column}`, width: 8 + Math.floor(random() * 20) })),
    }])),
    tickers: Array.from({ length: 120 }, (_, index) => ({
      symbol: `SYM${index}`,
      name: `Company ${index} Holdings Incorporated`,
      exchange: index % 2 ? "NASDAQ" : "NYSE",
      notes: "x".repeat(300),
    })),
    recentTickers: Array.from({ length: 50 }, (_, index) => `SYM${index}`),
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

/** One checkout's run: opened as the app opens it, driven for `seconds`, then closed. */
async function runWorkload(source: string, dbPath: string, seconds: number): Promise<RunResult> {
  const { AppPersistence } = await import(pathToFileURL(join(source, "src/data/app-persistence.ts")).href);
  const persistence = new AppPersistence(dbPath, { interactive: true });
  const ops: OpSamples = {};
  const time = (name: string, fn: () => unknown) => {
    const startedAt = performance.now();
    fn();
    (ops[name] ??= []).push(performance.now() - startedAt);
  };
  const random = seeded(23);
  const policy = { cachePolicy: { staleMs: 3_600_000, expireMs: 30 * 24 * 3_600_000 } };
  const ranges = ["1d", "5d", "1m", "6m", "ytd", "1y", "5y", "all"];

  const lags: number[] = [];
  let lastProbe = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - lastProbe - LAG_PROBE_MS));
    lastProbe = now;
  }, LAG_PROBE_MS);

  let elapsed = 0;
  let revision = 1;
  await new Promise<void>((done) => {
    const tick = setInterval(() => {
      elapsed += TICK_MS;
      if (elapsed % 1_000 === 0) {
        time("save session snapshot", () => persistence.sessions.set("app", sessionSnapshot(revision++)));
      }
      if (elapsed % 4_000 === 0) {
        time("save plugin state", () => persistence.pluginState.setMany([
          { pluginId: "watchlist", key: "selection", value: { symbol: `SYM${revision % 60}`, at: Date.now() } },
          { pluginId: "news", key: "read", value: Array.from({ length: 20 }, (_, index) => `story-${revision}-${index}`) },
        ]));
      }
      if (elapsed % 250 === 0) {
        time("save 10 quotes", () => {
          for (let index = 0; index < 10; index += 1) {
            const symbol = `SYM${Math.floor(random() * 450)}`;
            persistence.resources.set({ namespace: "market", kind: "quote", entityKey: symbol, sourceKey: "provider:a" }, { symbol, price: random() * 500, pad: "q".repeat(600) }, policy);
          }
        });
      }
      if (elapsed % 1_000 === 500) {
        time("read a quote", () => persistence.resources.get({ namespace: "market", kind: "quote", entityKey: `SYM${Math.floor(random() * 450)}`, sourceKey: "provider:a" }));
      }
      if (elapsed % 500 === 0) {
        const symbol = `SYM${Math.floor(random() * HISTORY_SYMBOLS)}`;
        const range = ranges[Math.floor(random() * ranges.length)]!;
        time("list a price history", () => persistence.resources.list(
          { namespace: "market", kind: "price-history", entityKey: symbol },
          { variantKeys: [`range=${range}`], sourceKeys: ["provider:a"], touchIntervalMs: 60_000 },
        ));
      }
      if (elapsed % 2_000 === 0) {
        const symbol = `SYM${Math.floor(random() * HISTORY_SYMBOLS)}`;
        time("save a price history", () => persistence.resources.set(
          { namespace: "market", kind: "price-history", entityKey: symbol, variantKey: `range=new${revision}`, sourceKey: "provider:a" },
          { rows: payloadOf(75 * KB) },
          policy,
        ));
      }
      if (elapsed % 3_000 === 1_500) {
        time("list financials", () => persistence.resources.list(
          { namespace: "market", kind: "financials", entityKey: `SYM${Math.floor(random() * 190)}` },
          { variantKeys: [""], sourceKeys: ["provider:a"] },
        ));
      }
      if (elapsed % 7_000 === 3_500) {
        // One in three asks for the 10 MB filing list.
        const symbol = random() < 1 / 3 ? "SYM0" : `SYM${1 + Math.floor(random() * 39)}`;
        time("list filings", () => persistence.resources.list(
          { namespace: "market", kind: "sec-filings", entityKey: symbol },
          { variantKeys: ["count=200"], sourceKeys: ["provider:a"] },
        ));
      }
      if (elapsed >= seconds * 1_000) {
        clearInterval(tick);
        done();
      }
    }, TICK_MS);
  });
  clearInterval(probe);
  const closingAt = performance.now();
  persistence.close();
  return { ops, lags, closeMs: performance.now() - closingAt };
}

interface Summary {
  label: string;
  runs: number;
  ops: Record<string, { count: number; p50: number; p95: number; max: number }>;
  longestPauseMs: number;
  pausesOver100Ms: number;
  pausesOver250Ms: number;
  closeMs: number;
}

function summarize(label: string, results: RunResult[]): Summary {
  const ops: Summary["ops"] = {};
  const names = [...new Set(results.flatMap((result) => Object.keys(result.ops)))].sort();
  for (const name of names) {
    const samples = results.flatMap((result) => result.ops[name] ?? []).sort((a, b) => a - b);
    ops[name] = { count: samples.length, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: samples.at(-1) ?? 0 };
  }
  const lags = results.flatMap((result) => result.lags);
  return {
    label,
    runs: results.length,
    ops,
    longestPauseMs: Math.max(0, ...lags),
    pausesOver100Ms: lags.filter((lag) => lag >= 100).length,
    pausesOver250Ms: lags.filter((lag) => lag >= 250).length,
    closeMs: Math.max(0, ...results.map((result) => result.closeMs)),
  };
}

function formatMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)}` : ms.toFixed(1);
}

function table(summaries: Summary[]): string {
  const names = [...new Set(summaries.flatMap((summary) => Object.keys(summary.ops)))].sort();
  const header = `| ms on the app's thread | ${summaries.map((summary) => `${summary.label} p50 / p95 / max`).join(" | ")} |`;
  const rule = `|---|${summaries.map(() => "---").join("|")}|`;
  const rows = names.map((name) => `| ${name} | ${summaries.map((summary) => {
    const op = summary.ops[name];
    return op ? `${formatMs(op.p50)} / ${formatMs(op.p95)} / ${formatMs(op.max)}` : "-";
  }).join(" | ")} |`);
  const pauses = `| longest event-loop pause | ${summaries.map((summary) => `${formatMs(summary.longestPauseMs)} (${summary.pausesOver100Ms} over 100 ms, ${summary.pausesOver250Ms} over 250)`).join(" | ")} |`;
  const close = `| close (longest) | ${summaries.map((summary) => formatMs(summary.closeMs)).join(" | ")} |`;
  return [header, rule, ...rows, pauses, close].join("\n");
}

async function child(): Promise<void> {
  const result = await runWorkload(resolve(arg("source")!), resolve(arg("db")!), Number(arg("seconds") ?? 45));
  process.stdout.write(`\nRESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const base = arg("base");
  const seconds = Number(arg("seconds") ?? 45);
  const runs = Number(arg("runs") ?? 2);
  const dir = resolve(arg("dir") ?? join(tmpdir(), "gloom-app-database-bench"));
  const out = arg("out");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const master = join(dir, "master.db");
  const seed = await seedMaster(master);
  console.log(`Seeded ${seed.rows} cached rows, ${(seed.bytes / MB).toFixed(1)} MB of payload.`);

  const checkouts = [
    ...(base ? [{ label: "base", source: resolve(base) }] : []),
    { label: "this branch", source: HEAD },
  ];
  const results = new Map<string, RunResult[]>(checkouts.map((checkout) => [checkout.label, []]));
  for (let run = 0; run < runs; run += 1) {
    // Alternate which goes first, so a runner that slows down mid-way weighs on both.
    const order = run % 2 === 0 ? checkouts : [...checkouts].reverse();
    for (const checkout of order) {
      const runDir = join(dir, `run-${run}-${checkout.label.replace(/\W+/g, "-")}`);
      mkdirSync(runDir, { recursive: true });
      const dbPath = join(runDir, ".gloomberb-cache.db");
      copyFileSync(master, dbPath);
      const spawned = spawnSync(process.execPath, [SCRIPT, "--child", "--source", checkout.source, "--db", dbPath, "--seconds", String(seconds)], {
        cwd: checkout.source,
        encoding: "utf8",
        maxBuffer: 256 * MB,
      });
      const line = spawned.stdout.split("\n").find((text) => text.startsWith("RESULT "));
      if (spawned.status !== 0 || !line) {
        throw new Error(`${checkout.label} run ${run + 1} failed (${spawned.status}):\n${spawned.stderr}`);
      }
      results.get(checkout.label)!.push(JSON.parse(line.slice("RESULT ".length)) as RunResult);
      rmSync(runDir, { recursive: true, force: true });
      console.log(`${checkout.label}: run ${run + 1} of ${runs} done`);
    }
  }
  rmSync(dir, { recursive: true, force: true });

  const summaries = checkouts.map((checkout) => summarize(checkout.label, results.get(checkout.label)!));
  const report = [
    `### App database on the app's thread (${process.platform}, ${runs} runs of ${seconds} s each, ${(seed.bytes / MB).toFixed(0)} MB cache)`,
    "",
    table(summaries),
    "",
  ].join("\n");
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (out) writeFileSync(out, JSON.stringify({ platform: process.platform, seconds, runs, seed, summaries }, null, 2));
}

if (process.argv.includes("--child")) {
  await child();
} else {
  if (arg("base") && !existsSync(join(resolve(arg("base")!), "src/data/app-persistence.ts"))) {
    throw new Error(`No checkout at ${arg("base")}`);
  }
  await main();
}
