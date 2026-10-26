import type { UpdateFailureReport } from "../api-client";
import type { UpdateChannel } from "../types/config";
import type { UpdateFailure } from "../updater/failure";
import { logFailure } from "../utils/log-failure";
import { compareSemver } from "../utils/semver";
import { VERSION } from "../version";
import { reportCrash, type CrashReportContext } from "./crash-reports";

/**
 * Failed update steps, sent to error tracking through the crash reporter (and
 * so behind the same off switch). A report is the step, a fixed code, the
 * versions, the channel, the platform and how the app was installed: never the
 * error's text, which can hold a path, a user name or a signed URL.
 *
 * The process that runs the update reports it: the terminal app, and the
 * desktop app's Bun process. The desktop view and the web install no host, so
 * the same failure is never sent twice. One report per step, code and app
 * version a day is enough to see a stuck updater; the hourly check that keeps
 * failing offline adds nothing after the first.
 *
 * The desktop host also keeps what an install was about to do, so the next
 * launch can tell an install that never took, or an update downloaded and
 * then quit without, from one that worked (`reviewLastUpdateAttempt`).
 */

/**
 * Where the running app sits. macOS installs replace the app bundle in place,
 * which only works from a folder the user can write: not from a disk image,
 * and not from the read-only copy App Translocation runs a quarantined app from.
 */
export type UpdateInstallKind =
  | "desktop-applications"
  | "desktop-translocated"
  | "desktop-volume"
  | "desktop-elsewhere"
  /** Windows and Linux: the app folder the installer created. */
  | "desktop-app-data"
  | "terminal-binary"
  | "terminal-managed"
  | "terminal-package-manager"
  | "terminal-source"
  | "unknown";

/** One update the app downloaded or started installing, and when. */
export interface UpdateAttempt {
  from: string;
  to: string;
  channel: UpdateChannel;
  at: number;
}

/** What the host keeps on disk between launches. */
export interface UpdateReportState {
  /** When each step, code and app version was last reported, in ms. */
  sent: Record<string, number>;
  /** A downloaded update waiting for the user's Restart. */
  staged?: UpdateAttempt;
  /** An install the user started; the next launch says whether it took. */
  applying?: UpdateAttempt;
}

export interface UpdateFailureReporterHost {
  installKind: UpdateInstallKind;
  /** The running version; defaults to this build's. */
  appVersion?: string;
  /** `process.platform` and `process.arch`. */
  platform: string;
  arch: string;
  load(): UpdateReportState;
  save(state: UpdateReportState): void;
  now?(): number;
  /** Defaults to the crash reporter. */
  send?(report: UpdateFailureReport): void;
}

export interface UpdateFailureContext {
  /** The version the update was going to, when one was known. */
  targetVersion?: string | null;
  channel?: UpdateChannel | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Older attempts say nothing about this launch: the user installed by hand, or reinstalled. */
const ATTEMPT_MAX_AGE_MS = 30 * DAY_MS;
/**
 * The install quits the app and opens the new one as soon as it is gone. A new
 * version first seen this long after is one the user opened again by hand.
 */
const RELAUNCH_GRACE_MS = 10 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,60})?$/;

let host: UpdateFailureReporterHost | null = null;

function cleanVersion(value: string | null | undefined): string | undefined {
  const version = value?.trim().replace(/^v/, "");
  return version && VERSION_PATTERN.test(version) ? version : undefined;
}

function reportPlatform(platform: string): UpdateFailureReport["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "other";
}

function reportArch(arch: string): UpdateFailureReport["arch"] {
  return arch === "arm64" || arch === "x64" ? arch : "other";
}

/**
 * The report, from fixed values only: anything that is not a version, a
 * known channel, platform or install kind is left out or named `other`.
 */
function buildUpdateFailureReport(
  failure: UpdateFailure,
  fields: UpdateFailureContext & {
    appVersion: string;
    platform: string;
    arch: string;
    installKind: UpdateInstallKind;
  },
): UpdateFailureReport {
  const targetVersion = cleanVersion(fields.targetVersion);
  return {
    phase: failure.phase,
    code: failure.code,
    appVersion: cleanVersion(fields.appVersion) ?? "unknown",
    ...(targetVersion ? { targetVersion } : {}),
    channel: fields.channel === "nightly" ? "nightly" : "stable",
    platform: reportPlatform(fields.platform),
    arch: reportArch(fields.arch),
    installKind: fields.installKind,
  };
}

/**
 * The report as the crash reporter sends it. Today's server keeps the error's
 * type, message, plugin and pane: the message is the step and code, so error
 * tracking groups one issue per failure, and the pane holds the rest as
 * `key=value` pairs. The `update` field carries the same values for a server
 * that reads it.
 */
function updateFailureCrashReport(report: UpdateFailureReport): {
  error: { name: string; message: string };
  context: CrashReportContext;
} {
  const details = [
    `to=${report.targetVersion ?? "none"}`,
    `channel=${report.channel}`,
    `platform=${report.platform}-${report.arch}`,
    `install=${report.installKind}`,
  ].join(" ");
  return {
    // A plain object, not an Error: it has no stack, so no file path goes along.
    error: { name: "UpdateFailed", message: `${report.phase}: ${report.code}` },
    context: { kind: "plugin", plugin: "updater", pane: details, update: report },
  };
}

function sendThroughCrashReporter(report: UpdateFailureReport): void {
  const { error, context } = updateFailureCrashReport(report);
  reportCrash(error, context);
}

/**
 * Takes the day's slot for `key`, or says it is used: one report per step,
 * code and version a day. Drops what is older than a day while at it.
 */
function takeReportSlot(state: UpdateReportState, key: string, now: number): boolean {
  for (const [entry, at] of Object.entries(state.sent)) {
    if (!(now - at < DAY_MS) || at > now) delete state.sent[entry];
  }
  if (state.sent[key] !== undefined) return false;
  state.sent[key] = now;
  return true;
}

function loadState(current: UpdateFailureReporterHost): UpdateReportState {
  try {
    const state = current.load();
    return { ...state, sent: { ...state.sent } };
  } catch (error) {
    logFailure("telemetry-update-failures", "Could not read update report state")(error);
    return { sent: {} };
  }
}

function saveState(current: UpdateFailureReporterHost, state: UpdateReportState): void {
  try {
    current.save(state);
  } catch (error) {
    logFailure("telemetry-update-failures", "Could not save update report state")(error);
  }
}

function sendIfDue(
  current: UpdateFailureReporterHost,
  state: UpdateReportState,
  failure: UpdateFailure,
  context: UpdateFailureContext,
  now: number,
): void {
  const report = buildUpdateFailureReport(failure, {
    ...context,
    appVersion: current.appVersion ?? VERSION,
    platform: current.platform,
    arch: current.arch,
    installKind: current.installKind,
  });
  if (!takeReportSlot(state, `${report.phase}|${report.code}|${report.appVersion}`, now)) return;
  (current.send ?? sendThroughCrashReporter)(report);
}

export function installUpdateFailureReporter(next: UpdateFailureReporterHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

/** Reports one failed step. Never throws; does nothing where no host is installed. */
export function reportUpdateFailure(failure: UpdateFailure, context: UpdateFailureContext = {}): void {
  const current = host;
  if (!current) return;
  try {
    const now = current.now?.() ?? Date.now();
    const state = loadState(current);
    // An install that failed in this run is reported here, not again at the next launch.
    if (failure.phase === "apply" || failure.phase === "relaunch") delete state.applying;
    sendIfDue(current, state, failure, context, now);
    saveState(current, state);
  } catch (error) {
    logFailure("telemetry-update-failures", "Could not report update failure")(error);
  }
}

function recordAttempt(field: "staged" | "applying", to: string, channel: UpdateChannel): void {
  const current = host;
  if (!current) return;
  const state = loadState(current);
  const attempt: UpdateAttempt = { from: current.appVersion ?? VERSION, to, channel, at: current.now?.() ?? Date.now() };
  if (field === "applying") delete state.staged;
  state[field] = attempt;
  saveState(current, state);
}

/** A downloaded update is waiting for the user's Restart. */
export function noteUpdateStaged(to: string, channel: UpdateChannel): void {
  recordAttempt("staged", to, channel);
}

/** The user pressed Restart: the next launch should be `to`. */
export function noteUpdateApplying(to: string, channel: UpdateChannel): void {
  recordAttempt("applying", to, channel);
}

/** The waiting update was taken back (a channel switch); quitting without it is no longer news. */
export function forgetStagedUpdate(): void {
  const current = host;
  if (!current) return;
  const state = loadState(current);
  if (!state.staged) return;
  delete state.staged;
  saveState(current, state);
}

/**
 * Run once at launch: what came of the last update this app started.
 *
 * - Restarted into the new version: nothing to report, unless the new version
 *   only came up long after, which is the app failing to reopen itself.
 * - Still the old version after an install: it never took.
 * - Still the old version with a download waiting: the app was quit without
 *   restarting into it, which the stuck installs may come down to.
 */
export function reviewLastUpdateAttempt(): void {
  const current = host;
  if (!current) return;
  const currentVersion = current.appVersion ?? VERSION;
  try {
    const state = loadState(current);
    const { applying, staged } = state;
    if (!applying && !staged) return;
    delete state.applying;
    delete state.staged;
    const now = current.now?.() ?? Date.now();
    const fresh = (attempt: UpdateAttempt | undefined) => !!attempt && now - attempt.at < ATTEMPT_MAX_AGE_MS && attempt.at <= now;
    if (applying && fresh(applying)) {
      const context = { targetVersion: applying.to, channel: applying.channel };
      if (applying.from === currentVersion) {
        sendIfDue(current, state, { phase: "apply", code: "not_applied" }, context, now);
      } else if ((compareSemver(currentVersion, applying.to) ?? -1) >= 0 && now - applying.at > RELAUNCH_GRACE_MS) {
        sendIfDue(current, state, { phase: "relaunch", code: "relaunch_missed" }, context, now);
      }
    } else if (staged && fresh(staged) && staged.from === currentVersion) {
      sendIfDue(current, state, { phase: "apply", code: "not_restarted" }, { targetVersion: staged.to, channel: staged.channel }, now);
    }
    saveState(current, state);
  } catch (error) {
    logFailure("telemetry-update-failures", "Could not review the last update")(error);
  }
}

/** Test seam. */
export function resetUpdateFailureReporterForTests(): void {
  host = null;
}
