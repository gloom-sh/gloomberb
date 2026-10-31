import { VERSION } from "../../version";
import { logFailure } from "../../utils/log-failure";
import type { CliCommandContext, CliCommandDef } from "../../types/plugin";
import { resolveCliDataDir } from "../data-dir";
import { CLI_COMMAND_GROUPS } from "../help";

/** Shared by the early entry point and the command registry. */
export async function printVersion(printResult: CliCommandContext["printResult"]): Promise<void> {
  // Reading the version never creates the data folder.
  let dataDir: string | null = null;
  try {
    dataDir = await resolveCliDataDir();
  } catch (error) {
    logFailure("cli-system", "Resolve data directory failed")(error);
  }
  printResult({
    data: [{
      version: VERSION,
      bun: typeof Bun === "undefined" ? null : Bun.version,
      platform: process.platform,
      arch: process.arch,
      dataDir,
    }],
  }, { layout: "record" });
}

export const versionCommand: CliCommandDef = {
  name: "version",
  aliases: ["--version", "-v"],
  description: "Print the version, runtime, and data folder",
  help: { group: CLI_COMMAND_GROUPS.app, usage: ["version"] },
  execute: (_args, ctx) => printVersion(ctx.printResult),
};
