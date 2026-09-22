import { dispatchCli, failUnknownCliCommand } from "./index";
import { inferCliErrorOptions, printCliError } from "./errors";
import { isCliHelpFlag } from "./options";
import { loadExternalPlugins } from "../plugins/loader";
import { restoreExtractedPlugins } from "./restore-plugins";
import type { CliLaunchRequest } from "../types/plugin";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
  PLUGIN_HOST_SMOKE_COMMAND,
  smokeOpenTuiNative,
  smokeOpenTuiRuntime,
  smokePluginHost,
} from "./native-smoke";

async function launchOpenTuiApp(options: {
  cliLaunchRequest?: CliLaunchRequest | null;
  cliArgs?: string[];
}): Promise<void> {
  const { startOpenTuiApp } = await import("../renderers/opentui/start");
  await restoreExtractedPlugins();
  const externalPlugins = await loadExternalPlugins("tui");
  await startOpenTuiApp({
    externalPlugins,
    cliArgs: options.cliArgs ?? [],
    skipCliDispatch: true,
    cliLaunchRequest: options.cliLaunchRequest ?? null,
  });
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

  if (!command) {
    await launchOpenTuiApp({});
    return;
  }

  if ((command === "launch-ui" || command === "ui") && !rawArgs.some(isCliHelpFlag)) {
    await launchOpenTuiApp({ cliArgs: rawArgs.slice(1) });
    return;
  }

  const externalPlugins = await loadExternalPlugins();
  const dispatchResult = await dispatchCli(rawArgs, { externalPlugins });
  if (dispatchResult.kind === "handled") return;
  if (dispatchResult.kind === "launch-ui") {
    await launchOpenTuiApp({
      cliLaunchRequest: dispatchResult.request,
      cliArgs: [],
    });
    return;
  }

  await failUnknownCliCommand(rawArgs, { externalPlugins });
}

runCliEntrypoint().catch((error) => {
  printCliError(error, inferCliErrorOptions(process.argv.slice(2)));
  process.exitCode = 1;
});
