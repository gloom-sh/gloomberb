import { readFileSync, statSync } from "fs";
import { join } from "path";
import { makePrivateDirSync, writePrivateFileSync } from "../utils/private-files";
import { createNodeReportStateStore, readSentMap } from "./node-report-state";
import type { StallReportState, StallReporterHost } from "./stall-reports";

/** Next to config.json: one line per stall, newest last. */
const STALL_LOG_FILE = "stall-log.txt";
/** Next to config.json: when each kind of stall was last reported, and the counts since. */
const STATE_FILE = "stall-reports.json";
/** Past this the log keeps its newer half. */
const LOG_MAX_BYTES = 256 * 1024;

function readCounts(value: unknown): StallReportState["pending"] {
  const pending: StallReportState["pending"] = {};
  if (!value || typeof value !== "object") return pending;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const { count, longestMs } = (entry ?? {}) as Record<string, unknown>;
    if (typeof count === "number" && Number.isFinite(count) && typeof longestMs === "number" && Number.isFinite(longestMs)) {
      pending[key] = { count, longestMs };
    }
  }
  return pending;
}

function readTimes(value: unknown): NonNullable<StallReportState["recent"]> {
  const recent: NonNullable<StallReportState["recent"]> = {};
  if (!value || typeof value !== "object") return recent;
  for (const [process, times] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(times)) continue;
    const kept = times.filter((at): at is number => typeof at === "number" && Number.isFinite(at));
    if (kept.length > 0) recent[process] = kept;
  }
  return recent;
}

function trimLog(path: string): void {
  if (statSync(path).size <= LOG_MAX_BYTES) return;
  const text = readFileSync(path, "utf-8");
  const keep = text.slice(text.length - LOG_MAX_BYTES / 2);
  writePrivateFileSync(path, keep.slice(keep.indexOf("\n") + 1));
}

/**
 * The stall reporter for a Bun process (the terminal app, the desktop app's
 * main process). Its log and state are readable by the user alone: the log
 * says what the user was doing when the app froze.
 */
export function createNodeStallReporterHost(options: {
  /** The profile's data folder, or null before the config is loaded. */
  getDataDir(): string | null;
}): StallReporterHost {
  const stateStore = createNodeReportStateStore<StallReportState>({
    fileName: STATE_FILE,
    getDataDir: options.getDataDir,
    empty: () => ({ sent: {}, pending: {}, recent: {} }),
    parse: (record) => ({ sent: readSentMap(record.sent), pending: readCounts(record.pending), recent: readTimes(record.recent) }),
    privateFile: true,
  });
  return {
    platform: process.platform,
    arch: process.arch,
    appendLog: (line) => {
      const dir = options.getDataDir();
      if (!dir) return;
      const path = join(dir, STALL_LOG_FILE);
      makePrivateDirSync(dir);
      writePrivateFileSync(path, `${line}\n`, { append: true });
      trimLog(path);
    },
    ...stateStore,
  };
}
