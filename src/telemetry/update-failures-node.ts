import type { UpdateChannel } from "../types/config";
import { createNodeReportStateStore, readSentMap } from "./node-report-state";
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
    ...createNodeReportStateStore<UpdateReportState>({
      fileName: STATE_FILE,
      getDataDir: options.getDataDir,
      empty: () => ({ sent: {} }),
      parse: (record) => {
        const staged = readAttempt(record.staged);
        const applying = readAttempt(record.applying);
        return { sent: readSentMap(record.sent), ...(staged ? { staged } : {}), ...(applying ? { applying } : {}) };
      },
      privateFile: false,
    }),
  };
}
