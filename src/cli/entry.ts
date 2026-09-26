import { dispatchCli, failUnknownCliCommand } from "./index";
import { inferCliErrorOptions, printCliError } from "./errors";
import { isCliHelpFlag } from "./options";
import { loadExternalPlugins } from "../plugins/loader";
import { restoreExtractedPlugins } from "./restore-plugins";
import { measurePerfAsync } from "../utils/perf-marks";
import type { CliLaunchRequest } from "../types/plugin";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
  PLUGIN_HOST_SMOKE_COMMAND,
  smokeOpenTuiNative,
  smokeOpenTuiRuntime,
  smokePluginHost,
} from "./native-smoke";

async function launchOpenTuiApp(cliLaunchRequest: CliLaunchRequest | null = null): Promise<void> {
  const { startOpenTuiApp } = await import("../renderers/opentui/start");
  // Before the catalog is read, so a plugin that moved out of this repository is
  // available in the same session rather than only after a restart.
  await measurePerfAsync("startup.opentui.restore-plugins", restoreExtractedPlugins);
  const externalPlugins = await measurePerfAsync("startup.opentui.load-external-plugins", () => loadExternalPlugins("tui"));
  await startOpenTuiApp({ externalPlugins, cliLaunchRequest });
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

  if (!command || ((command === "launch-ui" || command === "ui") && !rawArgs.some(isCliHelpFlag))) {
    await launchOpenTuiApp();
    return;
  }

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
