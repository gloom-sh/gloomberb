import { beforeEach } from "bun:test";
import { resetCrashReporterForTests } from "../telemetry/crash-reports";

/**
 * `bun test` runs every file in one process, so module state outlives the file
 * that set it. A crash report queued while no reporter is installed, such as a
 * plugin that fails to register in an app runtime test, would wait in the
 * queue and go out with the next reporter another file installs, and its key
 * would keep a later identical report from being queued at all. Every test
 * starts with no reporter, an empty queue and nothing seen.
 */
beforeEach(() => {
  resetCrashReporterForTests();
});
