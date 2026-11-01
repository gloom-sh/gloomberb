import "./opentui-libc";
import { inferCliErrorOptions, printCliError } from "./errors";
import { isCliHelpFlag } from "./options";
import { cliAsciiEnabled, plainByDefault, setCliPlainOverride } from "../utils/cli-output";
import { localeMayNotReadUtf8 } from "../utils/ascii-text";
import { writeAsciiWhile } from "./ascii-output";
import { measurePerfAsync } from "../utils/perf-marks";
import type { CliLaunchRequest } from "../types/plugin";
import { detectUpdateAction } from "../updater";
import { linkStandaloneCommand } from "../updater/command-names";
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
  // Before anything in the app can reach for the render library, so a temp
  // folder that cannot run it is worked around (or named) first.
  const { restoreExtractedPlugins } = await import("./restore-plugins");
  const { loadExternalPlugins } = await import("../plugins/loader");
  const { loadRenderLib } = await import("../renderers/opentui/render-lib");
  await measurePerfAsync("startup.opentui.render-lib", loadRenderLib);
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
    const { flushCrashReports, reportCrash } = await import("../telemetry/crash-reports");
    const { CRASH_REPORT_EXIT_FLUSH_MS } = await import("../telemetry/crash-reports-node");
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

  // The standalone binary updates by replacing itself, so one installed as
  // `gloomberb` before the rename gets `gloom` beside it here.
  if (detectUpdateAction()?.kind === "self") linkStandaloneCommand(process.execPath);

  if (!command || ((command === "launch-ui" || command === "ui") && !rawArgs.some(isCliHelpFlag))) {
    await launchOpenTuiApp();
    return;
  }

  // For a screen reader, a pipe or NO_COLOR: no rule lines, arrows in words, fixed table columns.
  setCliPlainOverride(plainByDefault());
  if (inferCliErrorOptions(rawArgs).format === "text" && localeMayNotReadUtf8()) writeAsciiWhile(cliAsciiEnabled);
  const { dispatchEarlyCommand } = await import("./early-command");
  if (await dispatchEarlyCommand(rawArgs)) return;

  const { dispatchCli, failUnknownCliCommand } = await import("./index");
  let plugins: Promise<import("../plugins/loader").LoadedExternalPlugin[]> | undefined;
  const options = {
    loadExternalPlugins: () => plugins ??= import("../plugins/loader").then(({ loadExternalPlugins }) => loadExternalPlugins()),
  };
  const dispatchResult = await dispatchCli(rawArgs, options);
  if (dispatchResult.kind === "handled") return;
  if (dispatchResult.kind === "launch-ui") {
    await launchOpenTuiApp(dispatchResult.request);
    return;
  }

  await failUnknownCliCommand(rawArgs, options);
}

runCliEntrypoint().catch((error) => {
  printCliError(error, inferCliErrorOptions(process.argv.slice(2)));
  process.exitCode = 1;
});
