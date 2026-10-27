import { logFailure } from "../utils/log-failure";
import type { StallEvent } from "../utils/main-thread-stall";
import { VERSION } from "../version";
import { reportCrash } from "./crash-reports";

/**
 * Freezes, made visible outside the app's own Debug Log.
 *
 * The stall monitor (utils/main-thread-stall.ts) notices when a process could
 * not answer the user for a while and names the last measured section, and
 * hands the stall to its sink. The terminal app and the desktop app's Bun
 * process record their own stalls here; the desktop window sends the stalls
 * it had in front of the user (stall-reports-dom.ts) to the Bun process,
 * which records them too. Where a host is installed, each
 * stall:
 *
 * - goes to a plain-text stall log in the profile folder, one line each, so a
 *   user or support can read what froze and when;
 * - from a second up, counts toward a report sent through the crash reporter
 *   (and so behind the same off switch), the way update failures are: the
 *   duration bucket, the section's fixed name, the process, the longest
 *   stall and how many there were. No free text: a section name keeps only
 *   its fixed leading part, so a ticker in a queue key never leaves.
 *
 * One report per process, bucket, section and app version a day; stalls of
 * the same kind after that are counted and carried in the next report.
 */

/** Which process stalled. */
export type StallProcess = "window" | "app" | "terminal";

/** What error tracking gets: fixed values only. */
export interface StallReport {
  process: StallProcess;
  bucket: StallBucket;
  section: string;
  appVersion: string;
  platform: "macos" | "windows" | "linux" | "other";
  arch: "arm64" | "x64" | "other";
  /** Stalls of this kind since the last report, this one included. */
  count: number;
  /** The longest of them, rounded to 100 ms. */
  longestMs: number;
}

type StallBucket = "1-2s" | "2-5s" | "5-15s" | "15s+";

/** What the host keeps on disk between launches. */
export interface StallReportState {
  /** When each kind was last reported, in ms. */
  sent: Record<string, number>;
  /** Stalls counted since each kind was last reported. */
  pending: Record<string, { count: number; longestMs: number }>;
}

export interface StallReporterHost {
  /** The running version; defaults to this build's. */
  appVersion?: string;
  platform: string;
  arch: string;
  /** Appends one line to the stall log. */
  appendLog(line: string): void;
  load(): StallReportState;
  save(state: StallReportState): void;
  now?(): number;
  /** Defaults to the crash reporter. */
  send?(report: StallReport): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Shorter freezes go to the log only. */
const STALL_REPORT_MIN_MS = 1_000;
const SECTION_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,60})?$/;
/** Kinds with counts waiting for their next report; the oldest go first past this. */
const MAX_KINDS_KEPT = 200;

let host: StallReporterHost | null = null;

/** The fixed part of a section name: lower-case dotted words, cut where anything else starts. */
function stallSectionName(name: string | undefined): string {
  if (!name) return "unmeasured";
  const match = SECTION_PATTERN.exec(name);
  const section = match?.[0].replace(/\.$/, "");
  return section && section.length <= 80 ? section : "unmeasured";
}

function stallBucket(blockedMs: number): StallBucket {
  if (blockedMs < 2_000) return "1-2s";
  if (blockedMs < 5_000) return "2-5s";
  if (blockedMs < 15_000) return "5-15s";
  return "15s+";
}

/** A stall another process sent over, kept only when it has the right shape. */
export function parseStallEvent(value: unknown): StallEvent | null {
  if (!value || typeof value !== "object") return null;
  const { blockedMs, lastMeasured, lastMeasuredEndedMsAgo } = value as Record<string, unknown>;
  if (typeof blockedMs !== "number" || !Number.isFinite(blockedMs) || blockedMs <= 0) return null;
  return {
    blockedMs,
    ...(typeof lastMeasured === "string" && lastMeasured.length <= 200 ? { lastMeasured } : {}),
    ...(typeof lastMeasuredEndedMsAgo === "number" && Number.isFinite(lastMeasuredEndedMsAgo) ? { lastMeasuredEndedMsAgo } : {}),
  };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** One line of the stall log: when, which process, how long, and what ran last. */
function formatStallLogLine(process: StallProcess, event: StallEvent, at: number): string {
  const time = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  const last = event.lastMeasured
    ? `last measured: ${event.lastMeasured}${event.lastMeasuredEndedMsAgo === undefined ? "" : `, ended ${Math.round(event.lastMeasuredEndedMsAgo)} ms before`}`
    : "nothing measured before it";
  return `${time}  ${process.padEnd(8)}  froze ${formatSeconds(event.blockedMs).padStart(6)}  ${last}`;
}

function reportPlatform(platform: string): StallReport["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "other";
}

function reportArch(arch: string): StallReport["arch"] {
  return arch === "arm64" || arch === "x64" ? arch : "other";
}

function sendThroughCrashReporter(report: StallReport): void {
  const details = [
    `process=${report.process}`,
    `count=${report.count}`,
    `longest=${report.longestMs}ms`,
    `platform=${report.platform}-${report.arch}`,
  ].join(" ");
  // A plain object, not an Error: it has no stack, so no file path goes along.
  // The message is the bucket and section, so error tracking keeps one issue per kind.
  reportCrash(
    { name: "MainThreadStall", message: `${report.bucket} after ${report.section}` },
    { kind: "plugin", plugin: "stall-monitor", pane: details },
  );
}

function loadState(current: StallReporterHost): StallReportState {
  try {
    const state = current.load();
    return { sent: { ...state.sent }, pending: { ...state.pending } };
  } catch (error) {
    logFailure("telemetry-stalls", "Could not read stall report state")(error);
    return { sent: {}, pending: {} };
  }
}

function prune(state: StallReportState, now: number): void {
  for (const [key, at] of Object.entries(state.sent)) {
    if (!(now - at < DAY_MS) || at > now) delete state.sent[key];
  }
  const kinds = Object.keys(state.pending);
  for (const key of kinds.slice(0, Math.max(0, kinds.length - MAX_KINDS_KEPT))) delete state.pending[key];
}

/** Records one stall of `process`. Does nothing where no host is installed; never throws. */
export function recordStall(process: StallProcess, event: StallEvent): void {
  const current = host;
  if (!current || !(event.blockedMs > 0)) return;
  try {
    const now = current.now?.() ?? Date.now();
    current.appendLog(formatStallLogLine(process, event, now));
    if (event.blockedMs < STALL_REPORT_MIN_MS) return;
    const appVersion = (current.appVersion ?? VERSION).trim().replace(/^v/, "");
    const section = stallSectionName(event.lastMeasured);
    const bucket = stallBucket(event.blockedMs);
    const version = VERSION_PATTERN.test(appVersion) ? appVersion : "unknown";
    const key = `${process}|${bucket}|${section}|${version}`;
    const state = loadState(current);
    prune(state, now);
    const pending = state.pending[key] ?? { count: 0, longestMs: 0 };
    pending.count += 1;
    pending.longestMs = Math.max(pending.longestMs, Math.round(event.blockedMs / 100) * 100);
    if (state.sent[key] !== undefined) {
      state.pending[key] = pending;
    } else {
      delete state.pending[key];
      state.sent[key] = now;
      (current.send ?? sendThroughCrashReporter)({
        process,
        bucket,
        section,
        appVersion: version,
        platform: reportPlatform(current.platform),
        arch: reportArch(current.arch),
        count: pending.count,
        longestMs: pending.longestMs,
      });
    }
    current.save(state);
  } catch (error) {
    logFailure("telemetry-stalls", "Could not record a stall")(error);
  }
}

export function installStallReporter(next: StallReporterHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

/** Test seam. */
export function resetStallReporterForTests(): void {
  host = null;
}
