import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, release } from "os";
import { join } from "path";
import type { CrashReportSurface } from "../api-client";
import type { TelemetryConfig } from "../types/config";
import {
  crashReportsEnabled,
  flushCrashReports,
  reportCrash,
  spoolPendingCrashReports,
  type CrashReporterHost,
  type SpooledCrashReport,
} from "./crash-reports";

/**
 * The crash reporter for a Bun process: the terminal app and the desktop
 * app's main process. Reads the off switch from the config and the
 * environment, keeps the install id in a file next to config.json, and
 * spools a batch to disk when the process is about to die.
 */

const INSTALL_ID_FILE = "install-id";
const SPOOL_FILE = "crash-reports.json";
const MAX_SPOOLED_REPORTS = 5;
const INSTALL_ID = /^[a-f0-9-]{36}$/;
/** How long an exit path waits for a report before leaving anyway. */
export const CRASH_REPORT_EXIT_FLUSH_MS = 1_500;

const installIds = new Map<string, string>();

/** Platform, kernel release and architecture, such as `darwin 24.5.0 arm64`. */
export function describeNodeOs(): string {
  let osRelease = "";
  try {
    osRelease = release();
  } catch {
    /* Unavailable on some runtimes; the platform alone still helps. */
  }
  return [process.platform, osRelease, process.arch].filter(Boolean).join(" ");
}

/**
 * The random id that identifies this install in crash reports and usage
 * counts, created on first use and kept in `<dataDir>/install-id`. It is used
 * for nothing else.
 */
export function readOrCreateInstallId(dataDir: string): string | null {
  const cached = installIds.get(dataDir);
  if (cached) return cached;
  const path = join(dataDir, INSTALL_ID_FILE);
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (INSTALL_ID.test(existing)) {
      installIds.set(dataDir, existing);
      return existing;
    }
  } catch {
    /* First run, or unreadable: create one below. */
  }
  try {
    const created = crypto.randomUUID();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${created}\n`, "utf-8");
    installIds.set(dataDir, created);
    return created;
  } catch {
    return null;
  }
}

function spoolPath(dataDir: string): string {
  return join(dataDir, SPOOL_FILE);
}

function readSpool(dataDir: string): SpooledCrashReport[] {
  try {
    const path = spoolPath(dataDir);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as SpooledCrashReport[]).slice(0, MAX_SPOOLED_REPORTS) : [];
  } catch {
    return [];
  }
}

export interface NodeCrashReporterHostOptions {
  surface: CrashReportSurface;
  /** The current config, or null before it is loaded. */
  getConfig(): { dataDir: string; telemetry?: TelemetryConfig } | null;
  env?: Record<string, string | undefined>;
}

export function createNodeCrashReporterHost(options: NodeCrashReporterHostOptions): CrashReporterHost {
  const env = options.env ?? process.env;
  const dataDir = () => options.getConfig()?.dataDir ?? null;
  return {
    surface: options.surface,
    os: describeNodeOs(),
    homeDir: homedir(),
    isEnabled: () => crashReportsEnabled(options.getConfig(), env),
    getInstallId: () => {
      const dir = dataDir();
      return dir ? readOrCreateInstallId(dir) : null;
    },
    spool: (report) => {
      const dir = dataDir();
      if (!dir) return;
      const reports = [...readSpool(dir), report].slice(-MAX_SPOOLED_REPORTS);
      writeFileSync(spoolPath(dir), JSON.stringify(reports), "utf-8");
    },
    clearSpool: () => {
      const dir = dataDir();
      if (dir) rmSync(spoolPath(dir), { force: true });
    },
    takeSpooled: async () => {
      const dir = dataDir();
      if (!dir) return [];
      const reports = readSpool(dir);
      rmSync(spoolPath(dir), { force: true });
      return reports;
    },
  };
}


/**
 * A read from a terminal that has gone away (its window closed, its tmux pane
 * killed) fails with EIO just before the hangup signal ends the process. That
 * is the user leaving, not a crash.
 */
function isTerminalHangup(error: unknown): boolean {
  const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
  return code === "EIO" && syscall === "read";
}

function exitAfterFlush(error: unknown): void {
  // The default for a process with no listener: print the error and exit 1.
  console.error(error);
  void flushCrashReports({ timeoutMs: CRASH_REPORT_EXIT_FLUSH_MS }).finally(() => process.exit(1));
}

/**
 * Reports uncaught exceptions and unhandled rejections.
 *
 * Whether the process survives is decided by whoever else listens: the
 * terminal renderer logs and carries on, and Electrobun stops the desktop
 * process. This listener only reports, and it goes first so a listener that
 * exits synchronously (Electrobun's does) still leaves a spooled batch on
 * disk for the next launch. When it is the only listener, it keeps the
 * runtime's default of exiting with status 1, after a bounded flush.
 */
export function installProcessCrashListeners(): () => void {
  const onUncaughtException = (error: unknown) => {
    if (!isTerminalHangup(error)) {
      reportCrash(error, { kind: "uncaught" });
      spoolPendingCrashReports();
    }
    if (process.listenerCount("uncaughtException") <= 1) exitAfterFlush(error);
  };
  const onUnhandledRejection = (reason: unknown) => {
    reportCrash(reason, { kind: "unhandled-rejection" });
    if (process.listenerCount("unhandledRejection") <= 1) exitAfterFlush(reason);
  };
  process.prependListener("uncaughtException", onUncaughtException);
  process.prependListener("unhandledRejection", onUnhandledRejection);
  return () => {
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
  };
}
