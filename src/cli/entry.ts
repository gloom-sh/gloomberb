import { dispatchCli } from "./index";
import { fail, inferCliErrorOptions, printCliError } from "./errors";
import { loadExternalPlugins } from "../plugins/loader";
import type { CliLaunchRequest } from "../types/plugin";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
  smokeOpenTuiNative,
  smokeOpenTuiRuntime,
} from "./native-smoke";

async function launchOpenTuiApp(options: {
  externalPlugins: Awaited<ReturnType<typeof loadExternalPlugins>>;
  cliLaunchRequest?: CliLaunchRequest | null;
  cliArgs?: string[];
}): Promise<void> {
  const { startOpenTuiApp } = await import("../renderers/opentui/start");
  await startOpenTuiApp({
    externalPlugins: options.externalPlugins,
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

  const externalPlugins = await loadExternalPlugins();

  if (!command) {
    await launchOpenTuiApp({ externalPlugins });
    return;
  }

  if (command === "launch-ui" || command === "ui") {
    await launchOpenTuiApp({ externalPlugins, cliArgs: rawArgs.slice(1) });
    return;
  }

  const dispatchResult = await dispatchCli(rawArgs, { externalPlugins });
  if (dispatchResult.kind === "handled") return;
  if (dispatchResult.kind === "launch-ui") {
    await launchOpenTuiApp({
      externalPlugins,
      cliLaunchRequest: dispatchResult.request,
      cliArgs: [],
    });
    return;
  }

  fail(`Unknown command "${command}".`, "Run gloomberb help to list available commands.");
}

runCliEntrypoint().catch((error) => {
  printCliError(error, inferCliErrorOptions(process.argv.slice(2)));
  process.exitCode = 1;
});
