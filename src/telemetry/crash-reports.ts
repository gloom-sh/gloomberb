import {
  apiClient,
  type CrashReportError,
  type CrashReportKind,
  type CrashReportSurface,
  type CrashReportsPayload,
} from "../api-client";
import type { TelemetryConfig } from "../types/config";
import { VERSION } from "../version";

/**
 * Automatic crash reports.
 *
 * Uncaught errors, unhandled rejections, render crashes and plugin load
 * failures are posted to Gloom's API, which forwards them to error tracking;
 * the app never talks to an analytics service itself. What leaves the
 * machine is the error (type, message, stack), the surface, the app version
 * and the OS. Nothing from the workspace goes along: no portfolio, config,
 * query, ticker list or layout. The user's home directory is replaced by `~`
 * before sending.
 *
 * The renderer installs a host that says which surface this is and where the
 * off switch lives; until then reports are held in memory, so a failure
 * during startup is still sent once the app is up. Reporting never throws
 * and never blocks: errors are batched, deduplicated per session and capped.
 */

const FLUSH_DELAY_MS = 2_000;
const MAX_ERRORS_PER_REQUEST = 10;
const MAX_ERRORS_PER_SESSION = 20;
/** Under the server's 64 KB body cap, with room for the envelope. */
const MAX_REQUEST_BYTES = 56 * 1024;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_STACK_LENGTH = 8_000;
const MAX_COMPONENT_STACK_LENGTH = 2_000;
const MAX_LABEL_LENGTH = 120;

export interface CrashReporterHost {
  surface: CrashReportSurface;
  /** Platform, release and architecture; clipped server-side to 60 characters. */
  os?: string;
  /** Replaced by `~` in messages and stacks before anything leaves the machine. */
  homeDir?: string | null;
  /** The off switch, read when an error is reported and again before sending. */
  isEnabled(): boolean;
  /** Random and stable per install. Null means nothing can be sent yet. */
  getInstallId(): Promise<string | null> | string | null;
  /**
   * Keeps a batch on disk synchronously, for a process that is about to die
   * before a request could complete. Cleared once a send succeeds.
   */
  spool?(payload: SpooledCrashReport): void;
  clearSpool?(): void;
  /** Batches left behind by a previous session, sent once at startup. */
  takeSpooled?(): Promise<SpooledCrashReport[]>;
  /** Defaults to the Cloud API client. */
  send?(payload: CrashReportsPayload): Promise<void>;
}

/** A batch written before the install id was known; it is added when sent. */
export type SpooledCrashReport = Omit<CrashReportsPayload, "installId">;

export interface CrashReportContext {
  kind: CrashReportKind;
  plugin?: string;
  pane?: string;
  /** React's component stack for a render crash; appended to the stack. */
  componentStack?: string | null;
}

interface PendingError {
  error: CrashReportError;
  key: string;
}

let host: CrashReporterHost | null = null;
let pending: PendingError[] = [];
const seen = new Set<string>();
let accepted = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let spooledKeys: string[] = [];

/** Reads the config switch and the environment. Absent means on. */
export function crashReportsEnabled(
  config: { telemetry?: TelemetryConfig } | null | undefined,
  env: Record<string, string | undefined> = {},
): boolean {
  if (config?.telemetry?.crashReports === false) return false;
  return !telemetryOptedOut(env);
}

/** `GLOOMBERB_NO_TELEMETRY` or `DO_NOT_TRACK` turns off everything the app sends on its own. */
export function telemetryOptedOut(env: Record<string, string | undefined>): boolean {
  return isOptOut(env.GLOOMBERB_NO_TELEMETRY) || isOptOut(env.DO_NOT_TRACK);
}

function isOptOut(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Replaces the home directory, in native, forward-slash and URL-encoded forms, with `~`. */
export function stripHomeDir(text: string, homeDir: string | null | undefined): string {
  const home = homeDir?.trim().replace(/[\\/]+$/, "");
  if (!home || home.length < 3) return text;
  const forms = new Set([home, home.replaceAll("\\", "/")]);
  for (const form of [...forms]) forms.add(encodeURI(form));
  let result = text;
  for (const form of forms) {
    result = result.replace(new RegExp(escapeRegExp(form), "gi"), "~");
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function describeError(error: unknown): { type: string; message: string; stack?: string } {
  if (error && typeof error === "object") {
    const record = error as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: unknown } };
    const type = readString(record.name) ?? readString(record.constructor?.name) ?? "Error";
    const message = readString(record.message) ?? type;
    return { type, message, stack: readString(record.stack) };
  }
  if (typeof error === "string") return { type: "Error", message: error || "Unknown error" };
  return { type: "Error", message: String(error) };
}

/**
 * The top frame, so two errors with the same type, message and origin count
 * once. V8 and Bun write `at fn (file:line:col)` under the message line;
 * WebKit writes `fn@file:line:col` with no message line at all.
 */
function topFrame(stack: string | undefined, type: string): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.startsWith("at "))
    ?? lines.find((line) => !line.startsWith(type))
    ?? "";
}

function toReportError(error: unknown, context: CrashReportContext): PendingError {
  const described = describeError(error);
  const componentStack = readString(context.componentStack?.trim());
  const stack = [
    described.stack ? clip(described.stack, MAX_STACK_LENGTH) : null,
    componentStack ? `Component stack:${clip(componentStack, MAX_COMPONENT_STACK_LENGTH)}` : null,
  ].filter((part): part is string => !!part).join("\n\n");
  return {
    key: `${described.type}\n${described.message}\n${topFrame(described.stack, described.type)}`,
    error: {
      kind: context.kind,
      type: clip(described.type, MAX_LABEL_LENGTH),
      message: clip(described.message, MAX_MESSAGE_LENGTH),
      ...(stack ? { stack } : {}),
      ...(context.plugin ? { plugin: clip(context.plugin, MAX_LABEL_LENGTH) } : {}),
      ...(context.pane ? { pane: clip(context.pane, MAX_LABEL_LENGTH) } : {}),
    },
  };
}

/**
 * Queues one error. Safe to call from any error handler: it never throws,
 * never awaits, and drops the error when reporting is off, already seen this
 * session, or over the session cap.
 */
export function reportCrash(error: unknown, context: CrashReportContext): void {
  try {
    if (host && !host.isEnabled()) return;
    if (accepted >= MAX_ERRORS_PER_SESSION) return;
    const entry = toReportError(error, context);
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    accepted += 1;
    pending.push(entry);
    scheduleFlush(pending.length >= MAX_ERRORS_PER_REQUEST ? 0 : FLUSH_DELAY_MS);
  } catch {
    /* A reporter that throws inside a crash handler would hide the crash. */
  }
}

/** Installs the surface's host and sends what a previous session left behind. */
export function installCrashReporter(next: CrashReporterHost): () => void {
  host = next;
  if (!next.isEnabled()) {
    pending = [];
  } else {
    void sendSpooled(next);
    if (pending.length > 0) scheduleFlush(FLUSH_DELAY_MS);
  }
  return () => {
    if (host === next) host = null;
  };
}

/**
 * Sends everything queued, waiting at most `timeoutMs`. For an exit path:
 * resolves as soon as the queue is empty, and never rejects.
 */
export async function flushCrashReports(options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? FLUSH_DELAY_MS;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0 && !inFlight) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([flushNow(), deadline]);
  } catch {
    /* Failures are swallowed; the caller is on its way out. */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Writes the queue to the host's spool, synchronously. For a process that
 * will be killed before `flushCrashReports` could finish, such as the
 * desktop Bun process after an uncaught exception.
 */
export function spoolPendingCrashReports(): void {
  try {
    if (!host?.spool || pending.length === 0 || !host.isEnabled()) return;
    const batch = takeBatch(pending, host).map((entry) => entry.error);
    host.spool({ surface: host.surface, appVersion: VERSION, ...(host.os ? { os: host.os } : {}), errors: batch });
    spooledKeys = pending.slice(0, batch.length).map((entry) => entry.key);
  } catch {
    /* Best effort. */
  }
}

function scheduleFlush(delayMs: number): void {
  if (!host) return;
  if (flushTimer) {
    if (delayMs > 0) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, delayMs);
  // A pending report must not keep a process alive that is otherwise done;
  // exit paths flush explicitly.
  (flushTimer as { unref?: () => void }).unref?.();
}

async function flushNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      while (host && pending.length > 0) {
        const current = host;
        if (!current.isEnabled()) {
          pending = [];
          return;
        }
        const installId = await current.getInstallId();
        if (!installId) return;
        const batch = takeBatch(pending, current);
        pending = pending.slice(batch.length);
        const errors = batch.map((entry) => scrub(entry.error, current.homeDir));
        try {
          await send(current, {
            installId,
            surface: current.surface,
            appVersion: VERSION,
            ...(current.os ? { os: current.os } : {}),
            errors,
          });
          if (spooledKeys.length > 0 && batch.some((entry) => spooledKeys.includes(entry.key))) {
            spooledKeys = [];
            current.clearSpool?.();
          }
        } catch {
          // One request that could not be sent is not retried; the spool, when
          // the host has one, still carries it into the next session.
        }
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** As many errors as fit one request: at most 10, and under the body cap. */
function takeBatch(queue: PendingError[], current: CrashReporterHost): PendingError[] {
  const batch: PendingError[] = [];
  let bytes = 0;
  for (const entry of queue) {
    const size = JSON.stringify(scrub(entry.error, current.homeDir)).length;
    if (batch.length > 0 && (batch.length >= MAX_ERRORS_PER_REQUEST || bytes + size > MAX_REQUEST_BYTES)) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
}

function scrub(error: CrashReportError, homeDir: string | null | undefined): CrashReportError {
  return {
    ...error,
    message: stripHomeDir(error.message, homeDir),
    ...(error.stack ? { stack: stripHomeDir(error.stack, homeDir) } : {}),
  };
}

function send(current: CrashReporterHost, payload: CrashReportsPayload): Promise<void> {
  return current.send ? current.send(payload) : apiClient.reportCrashErrors(payload);
}

async function sendSpooled(current: CrashReporterHost): Promise<void> {
  try {
    if (!current.takeSpooled) return;
    const spooled = await current.takeSpooled();
    if (spooled.length === 0) return;
    const installId = await current.getInstallId();
    if (!installId || !current.isEnabled()) return;
    for (const report of spooled) {
      if (!Array.isArray(report.errors) || report.errors.length === 0) continue;
      await send(current, { installId, ...report, errors: report.errors.map((error) => scrub(error, current.homeDir)) });
    }
  } catch {
    /* A report from last time is not worth a failure this time. */
  }
}

/** Test seam: forgets the host, the queue and everything seen this session. */
export function resetCrashReporterForTests(): void {
  host = null;
  pending = [];
  seen.clear();
  accepted = 0;
  spooledKeys = [];
  inFlight = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
