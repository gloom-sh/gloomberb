import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { UpdateChannel } from "../types/config";
import type {
  UpdateAttempt,
  UpdateFailureReporterHost,
  UpdateInstallKind,
  UpdateReportState,
} from "./update-failures";

/** Next to config.json: when each update failure was last reported, and the last update attempt. */
const STATE_FILE = "update-reports.json";

function readAttempt(value: unknown): UpdateAttempt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { from, to, channel, at } = value as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string" || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { from, to, channel: (channel === "nightly" ? "nightly" : "stable") satisfies UpdateChannel, at };
}

/** The saved state, keeping only entries of the right shape. */
function parseUpdateReportState(text: string): UpdateReportState {
  const parsed: unknown = JSON.parse(text);
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const sent: Record<string, number> = {};
  if (record.sent && typeof record.sent === "object") {
    for (const [key, at] of Object.entries(record.sent as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) sent[key] = at;
    }
  }
  const staged = readAttempt(record.staged);
  const applying = readAttempt(record.applying);
  return { sent, ...(staged ? { staged } : {}), ...(applying ? { applying } : {}) };
}

/** The update failure reporter for a Bun process (the terminal app, the desktop app's main process). */
export function createNodeUpdateFailureHost(options: {
  installKind: UpdateInstallKind;
  /** The profile's data folder, or null before the config is loaded. */
  getDataDir(): string | null;
}): UpdateFailureReporterHost {
  return {
    installKind: options.installKind,
    platform: process.platform,
    arch: process.arch,
    load: () => {
      const dir = options.getDataDir();
      const path = dir ? join(dir, STATE_FILE) : null;
      if (!path || !existsSync(path)) return { sent: {} };
      return parseUpdateReportState(readFileSync(path, "utf-8"));
    },
    save: (state) => {
      const dir = options.getDataDir();
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, STATE_FILE), JSON.stringify(state), "utf-8");
    },
  };
}
