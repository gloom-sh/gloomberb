import { beforeEach } from "bun:test";
import { resetCrashReporterForTests } from "../telemetry/crash-reports";
import { setCliAsciiLocaleOverride, setCliColorEnabledOverride, setCliPlainOverride, setCliWidthOverride } from "../utils/cli-output";

/**
 * `bun test` runs every file in one process, so module state outlives the file
 * that set it. A crash report queued while no reporter is installed, such as a
 * plugin that fails to register in an app runtime test, would wait in the
 * queue and go out with the next reporter another file installs, and its key
 * would keep a later identical report from being queued at all. Every test
 * starts with no reporter, an empty queue and nothing seen.
 *
 * Commands also keep output overrides for the process: a parity test that
 * runs --plain would otherwise make a later serializer test keep empty
 * columns. Start each test with the default output modes and terminal width.
 */
beforeEach(() => {
  resetCrashReporterForTests();
  setCliAsciiLocaleOverride(null);
  setCliColorEnabledOverride(null);
  setCliPlainOverride(null);
  setCliWidthOverride(null);
});
