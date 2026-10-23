import "./opentui-libc";
import { inferCliErrorOptions, printCliError } from "./errors";
import { isCliHelpFlag } from "./options";
import { plainByDefault, setCliPlainOverride } from "../utils/cli-output";
import { loadExternalPlugins } from "../plugins/loader";
import { restoreExtractedPlugins } from "./restore-plugins";
import { measurePerfAsync } from "../utils/perf-marks";
import { flushCrashReports, reportCrash } from "../telemetry/crash-reports";
import { CRASH_REPORT_EXIT_FLUSH_MS } from "../telemetry/crash-reports-node";
import type { CliLaunchRequest } from "../types/plugin";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
  PLUGIN_HOST_SMOKE_COMMAND,
  SHOT_VIEW_SMOKE_COMMAND,
  smokeOpenTuiNative,
  smokeOpenTuiRuntime,
  smokePluginHost,
  smokeShotView,
} from "./native-smoke";

async function launchOpenTuiApp(cliLaunchRequest: CliLaunchRequest | null = null): Promise<void> {
  const { startOpenTuiApp } = await import("../renderers/opentui/start");
  // Before the catalog is read, so a plugin that moved out of this repository is
  // available in the same session rather than only after a restart.
  await measurePerfAsync("startup.opentui.restore-plugins", restoreExtractedPlugins);
  const externalPlugins = await measurePerfAsync("startup.opentui.load-external-plugins", () => loadExternalPlugins("tui"));
  try {
    await startOpenTuiApp({ externalPlugins, cliLaunchRequest });
  } catch (error) {
    // A failed launch still prints and exits as before; the report is only
    // sent when the config was read far enough to install the reporter.
    reportCrash(error, { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: CRASH_REPORT_EXIT_FLUSH_MS });
    throw error;
  }
}

export async function runCliEntrypoint(rawArgs = process.argv.slice(2)): Promise<void> {
  const command = rawArgs[0];

  if (command === OPEN_TUI_NATIVE_SMOKE_COMMAND) {
    await smokeOpenTuiNative();
    process.exit(0);
  }

  if (command === OPEN_TUI_RUNTIME_SMOKE_COMMAND) {
    await smokeOpenTuiRuntime();
    process.exit(0);
  }

  if (command === PLUGIN_HOST_SMOKE_COMMAND) {
    await smokePluginHost();
    process.exit(0);
  }

  if (command === SHOT_VIEW_SMOKE_COMMAND) {
    await smokeShotView();
    process.exit(0);
  }

  if (!command || ((command === "launch-ui" || command === "ui") && !rawArgs.some(isCliHelpFlag))) {
    await launchOpenTuiApp();
    return;
  }

  // Loaded only for a command: a bare launch never reads the commands, and
  // their modules are a noticeable part of what it would load before drawing.
  const { dispatchCli, failUnknownCliCommand } = await import("./index");
  // For a screen reader, a pipe or NO_COLOR: no rule lines, arrows in words, fixed table columns. Set
  // for this process only; `--plain` turns it on in dispatchCli, and commands run in-process keep theirs.
  setCliPlainOverride(plainByDefault());
  const externalPlugins = await loadExternalPlugins();
  const dispatchResult = await dispatchCli(rawArgs, { externalPlugins });
  if (dispatchResult.kind === "handled") return;
  if (dispatchResult.kind === "launch-ui") {
    await launchOpenTuiApp(dispatchResult.request);
    return;
  }

  await failUnknownCliCommand(rawArgs, { externalPlugins });
}

runCliEntrypoint().catch((error) => {
  printCliError(error, inferCliErrorOptions(process.argv.slice(2)));
  process.exitCode = 1;
});
