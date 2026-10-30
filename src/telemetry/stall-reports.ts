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
 * A report also says when in the process's life the stall came (still
 * starting or up, and an uptime bucket), how long before it the named section
 * ended (or that it ended inside it, which makes it the likely cause), and,
 * for the desktop app's own process, whether the app was in front and had a
 * window on screen: a hidden app's slowed timers read like a freeze. A stall
 * after a SQLite statement names the statement (a fixed name), its tries and
 * whether it waited on another program's lock. Where the platform's clocks
 * can be read, it says how much of the stall the thread spent on the CPU
 * and how busy the process's other threads were, which tells script or a
 * collection (busy) from a wait on the disk, a lock or another thread
 * (idle); the time the computer slept never counts as a stall (see
 * utils/main-thread-stall.ts). All of it is buckets and flags.
 *
 * One report per process, bucket, section and app version a day; stalls of
 * the same kind after that are counted and carried in the next report, and
 * every report says how many stalls the process had in the last day.
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
  /** This process's stalls of a second or more in the last 24 hours, this one included. */
  day: number;
  /** Whether the process had finished starting. */
  phase: "startup" | "steady" | "unknown";
  uptime: UptimeBucket | "unknown";
  /** How long before the stall began the section ended; "in" when it ended inside it. */
  gap: GapBucket;
  /** The desktop app's own process: whether the app was in front (null: not known yet). */
  active?: boolean | null;
  /** The desktop app's own process: whether a window was open and not minimized. */
  visible?: boolean | null;
  /** After a SQLite statement: how many tries it took. */
  attempts?: number;
  /** After a SQLite statement: whether it waited on another connection's lock. */
  lockWait?: boolean;
  /** Where the platform says: the share of the stall the thread was on the CPU, in percent, by tens. */
  cpuPercent?: number;
  /** Where the platform says: the CPU the process's other threads used meanwhile, in percent of one core, by tens. */
  otherCpuPercent?: number;
}

type StallBucket = "1-2s" | "2-5s" | "5-15s" | "15s+";
type UptimeBucket = "<30s" | "30s-2m" | "2-10m" | "10-60m" | "1-6h" | "6-24h" | "1d+";
type GapBucket = "none" | "in" | "<1s" | "1-10s" | "10-60s" | "1-10m" | "10m+";

/** What the desktop app's Bun process can tell about whether anyone was looking. */
export interface StallAttention {
  /** One of the app's windows had the keyboard; null before the first focus change. */
  active: boolean | null;
  /** One of the app's windows was open and not minimized; null when it could not be read. */
  visible: boolean | null;
}

/** What the host keeps on disk between launches. */
export interface StallReportState {
  /** When each kind was last reported, in ms. */
  sent: Record<string, number>;
  /** Stalls counted since each kind was last reported. */
  pending: Record<string, { count: number; longestMs: number }>;
  /** When each process's stalls of a second or more in the last day happened, oldest first. */
  recent?: Record<string, number[]>;
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
/** Stall times kept per process for the day count. */
const MAX_RECENT_KEPT = 500;
/** What error tracking keeps of the details line; fields that do not fit are left out. */
const MAX_DETAILS_LENGTH = 120;
/** Other threads' CPU past this many percent of a core reads as this. */
const MAX_OTHER_CPU_PERCENT = 990;

let host: StallReporterHost | null = null;
let attentionProbe: (() => StallAttention) | null = null;

/** The fixed part of a section name: lower-case dotted words, cut where anything else starts. */
function stallSectionName(name: string | undefined): string {
  if (!name) return "unmeasured";
  const match = SECTION_PATTERN.exec(name);
  const section = match?.[0].replace(/\.$/, "");
  return section && section.length <= 80 ? section : "unmeasured";
}

/** The section a report names; a SQLite statement's adds the statement's fixed name. */
function reportSection(event: StallEvent): string {
  const section = stallSectionName(event.lastMeasured);
  if (section !== "sqlite.blocked" || !event.sqlite) return section;
  const operation = event.sqlite.operation.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const named = `${section}.${operation}`.replace(/-+$/, "");
  return SECTION_PATTERN.exec(named)?.[0] === named ? named : section;
}

function stallBucket(blockedMs: number): StallBucket {
  if (blockedMs < 2_000) return "1-2s";
  if (blockedMs < 5_000) return "2-5s";
  if (blockedMs < 15_000) return "5-15s";
  return "15s+";
}

function uptimeBucket(uptimeMs: number | undefined): UptimeBucket | "unknown" {
  if (uptimeMs === undefined) return "unknown";
  const minutes = uptimeMs / 60_000;
  if (minutes < 0.5) return "<30s";
  if (minutes < 2) return "30s-2m";
  if (minutes < 10) return "2-10m";
  if (minutes < 60) return "10-60m";
  if (minutes < 360) return "1-6h";
  if (minutes < 1_440) return "6-24h";
  return "1d+";
}

/**
 * How long before the stall began the last measured section ended. A
 * section that ended inside the stall ran during it ("in"): the likely
 * cause. Anything after that is time nothing measured ran in.
 */
function gapBucket(event: StallEvent): GapBucket {
  if (!event.lastMeasured || event.lastMeasuredEndedMsAgo === undefined) return "none";
  const gapMs = event.lastMeasuredEndedMsAgo - event.blockedMs;
  if (gapMs <= 0) return "in";
  if (gapMs < 1_000) return "<1s";
  if (gapMs < 10_000) return "1-10s";
  if (gapMs < 60_000) return "10-60s";
  if (gapMs < 600_000) return "1-10m";
  return "10m+";
}

/** A stall another process sent over, kept only when it has the right shape. */
export function parseStallEvent(value: unknown): StallEvent | null {
  if (!value || typeof value !== "object") return null;
  const { blockedMs, lastMeasured, lastMeasuredEndedMsAgo, sqlite, uptimeMs, phase } = value as Record<string, unknown>;
  if (typeof blockedMs !== "number" || !Number.isFinite(blockedMs) || blockedMs <= 0) return null;
  const detail = sqlite && typeof sqlite === "object" ? sqlite as Record<string, unknown> : null;
  return {
    blockedMs,
    ...(typeof lastMeasured === "string" && lastMeasured.length <= 200 ? { lastMeasured } : {}),
    ...(typeof lastMeasuredEndedMsAgo === "number" && Number.isFinite(lastMeasuredEndedMsAgo) ? { lastMeasuredEndedMsAgo } : {}),
    ...(detail && typeof detail.operation === "string" && detail.operation.length <= 80
      && typeof detail.attempts === "number" && Number.isFinite(detail.attempts)
      ? { sqlite: { operation: detail.operation, attempts: detail.attempts, lockWait: detail.lockWait === true } }
      : {}),
    ...(typeof uptimeMs === "number" && Number.isFinite(uptimeMs) && uptimeMs >= 0 ? { uptimeMs } : {}),
    ...(phase === "startup" || phase === "steady" ? { phase } : {}),
  };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function flag(value: boolean | null | undefined): string {
  return value == null ? "?" : value ? "1" : "0";
}

/** A share or a core count in percent, by tens. */
function tens(value: number | undefined, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, Math.round(value * 10) * 10));
}

/** The context a report carries, also written at the end of the log line. */
interface StallContext {
  phase: StallReport["phase"];
  uptime: StallReport["uptime"];
  gap: GapBucket;
  attention: StallAttention | null;
  cpuPercent?: number;
  otherCpuPercent?: number;
}

function stallContext(event: StallEvent, attention: StallAttention | null): StallContext {
  const cpuPercent = tens(event.threadCpu, 100);
  const otherCpuPercent = tens(event.otherCpu, MAX_OTHER_CPU_PERCENT);
  return {
    phase: event.phase ?? "unknown",
    uptime: uptimeBucket(event.uptimeMs),
    gap: gapBucket(event),
    attention,
    ...(cpuPercent === undefined ? {} : { cpuPercent }),
    ...(otherCpuPercent === undefined ? {} : { otherCpuPercent }),
  };
}

/** One line of the stall log: when, which process, how long, what ran last, and when in the process's life. */
function formatStallLogLine(process: StallProcess, event: StallEvent, context: StallContext, at: number): string {
  const time = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
  const last = event.lastMeasured
    ? `last measured: ${event.lastMeasured}${event.lastMeasuredEndedMsAgo === undefined ? "" : `, ended ${Math.round(event.lastMeasuredEndedMsAgo)} ms before`}`
    : "nothing measured before it";
  const sqlite = event.sqlite
    ? ` (${event.sqlite.operation}, ${event.sqlite.attempts} ${event.sqlite.attempts === 1 ? "try" : "tries"}${event.sqlite.lockWait ? ", waited on a lock" : ""})`
    : "";
  const facts = [
    `phase=${context.phase}`,
    `up=${context.uptime}`,
    `gap=${context.gap}`,
    ...(context.attention ? [`fg=${flag(context.attention.active)}`, `vis=${flag(context.attention.visible)}`] : []),
    ...(context.cpuPercent === undefined ? [] : [`cpu=${context.cpuPercent}`]),
    ...(context.otherCpuPercent === undefined ? [] : [`oth=${context.otherCpuPercent}`]),
  ].join(" ");
  return `${time}  ${process.padEnd(8)}  froze ${formatSeconds(event.blockedMs).padStart(6)}  ${last}${sqlite}  [${facts}]`;
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

/**
 * The details line error tracking keeps, most telling first. The platform
 * comes last: error tracking has the system and its architecture already.
 * One that would not fit is left out.
 */
export function formatStallReportDetails(report: StallReport): string {
  const fields = [
    `process=${report.process}`,
    `count=${report.count}`,
    `longest=${report.longestMs}ms`,
    `phase=${report.phase}`,
    `up=${report.uptime}`,
    `gap=${report.gap}`,
    ...(report.active === undefined ? [] : [`fg=${flag(report.active)}`]),
    ...(report.visible === undefined ? [] : [`vis=${flag(report.visible)}`]),
    ...(report.cpuPercent === undefined ? [] : [`cpu=${report.cpuPercent}`]),
    ...(report.otherCpuPercent === undefined ? [] : [`oth=${report.otherCpuPercent}`]),
    ...(report.lockWait === undefined ? [] : [`lock=${flag(report.lockWait)}`]),
    ...(report.attempts === undefined ? [] : [`try=${report.attempts}`]),
    `day=${report.day}`,
    `platform=${report.platform}-${report.arch}`,
  ];
  let details = "";
  for (const field of fields) {
    const next = details ? `${details} ${field}` : field;
    if (next.length <= MAX_DETAILS_LENGTH) details = next;
  }
  return details;
}

function sendThroughCrashReporter(report: StallReport): void {
  const details = formatStallReportDetails(report);
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
    return { sent: { ...state.sent }, pending: { ...state.pending }, recent: { ...state.recent } };
  } catch (error) {
    logFailure("telemetry-stalls", "Could not read stall report state")(error);
    return { sent: {}, pending: {}, recent: {} };
  }
}

function prune(state: StallReportState, now: number): void {
  for (const [key, at] of Object.entries(state.sent)) {
    if (!(now - at < DAY_MS) || at > now) delete state.sent[key];
  }
  const kinds = Object.keys(state.pending);
  for (const key of kinds.slice(0, Math.max(0, kinds.length - MAX_KINDS_KEPT))) delete state.pending[key];
  for (const [process, times] of Object.entries(state.recent ?? {})) {
    const kept = times.filter((at) => now - at < DAY_MS && at <= now);
    if (kept.length > 0) state.recent![process] = kept;
    else delete state.recent![process];
  }
}

/** Never throws: a probe that fails reads as not known. */
function readAttention(): StallAttention | null {
  if (!attentionProbe) return null;
  try {
    return attentionProbe();
  } catch {
    // Intentional ignore: a window that cannot be read leaves the report saying it is not known.
    return { active: null, visible: null };
  }
}

/** Records one stall of `process`. Does nothing where no host is installed; never throws. */
export function recordStall(process: StallProcess, event: StallEvent): void {
  const current = host;
  if (!current || !(event.blockedMs > 0)) return;
  try {
    const now = current.now?.() ?? Date.now();
    const reportable = event.blockedMs >= STALL_REPORT_MIN_MS;
    // Asked only of a stall that will be reported: the probe reads the windows.
    const context = stallContext(event, reportable && process === "app" ? readAttention() : null);
    current.appendLog(formatStallLogLine(process, event, context, now));
    if (!reportable) return;
    const appVersion = (current.appVersion ?? VERSION).trim().replace(/^v/, "");
    const section = reportSection(event);
    const bucket = stallBucket(event.blockedMs);
    const version = VERSION_PATTERN.test(appVersion) ? appVersion : "unknown";
    const key = `${process}|${bucket}|${section}|${version}`;
    const state = loadState(current);
    prune(state, now);
    const recent = [...(state.recent?.[process] ?? []), now].slice(-MAX_RECENT_KEPT);
    state.recent = { ...state.recent, [process]: recent };
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
        day: recent.length,
        phase: context.phase,
        uptime: context.uptime,
        gap: context.gap,
        ...(context.attention ? { active: context.attention.active, visible: context.attention.visible } : {}),
        ...(context.cpuPercent === undefined ? {} : { cpuPercent: context.cpuPercent }),
        ...(context.otherCpuPercent === undefined ? {} : { otherCpuPercent: context.otherCpuPercent }),
        ...(event.sqlite && section.startsWith("sqlite.blocked")
          ? { attempts: Math.max(1, Math.min(99, Math.round(event.sqlite.attempts))), lockWait: event.sqlite.lockWait }
          : {}),
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

/** How the desktop app's Bun process tells whether anyone was looking when it froze (bun/window/attention.ts). */
export function setStallAttentionProbe(next: (() => StallAttention) | null): () => void {
  attentionProbe = next;
  return () => {
    if (attentionProbe === next) attentionProbe = null;
  };
}

/** Test seam. */
export function resetStallReporterForTests(): void {
  host = null;
  attentionProbe = null;
}
