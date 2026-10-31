import { parseCliGlobalArgs } from "./options";
import { printVersion, versionCommand } from "./commands/version";
import { checkCliCommandOptions, foldCommandArgs } from "./command-options";
import { describeCliCommand, renderCommandHelp } from "./help";
import { printCliResult } from "./result";
import { printCliError } from "./errors";
import { setCliColorEnabledOverride, setCliPlainOverride, setCliWidthOverride } from "../utils/cli-output";
import { foldTypedText } from "../utils/typed-text";

/** Version and its help need neither a plugin registry nor application services. */
export async function dispatchEarlyCommand(args: string[]): Promise<boolean> {
  let parsed;
  try {
    parsed = parseCliGlobalArgs(args);
  } catch {
    // Intentional ignore: The regular dispatcher reports malformed global options.
    return false;
  }
  const token = foldTypedText(parsed.args[0] ?? "").trim().toLowerCase();
  if (token !== versionCommand.name && !versionCommand.aliases?.includes(token)) return false;
  const options = parsed.options;
  setCliColorEnabledOverride(options.color);
  setCliWidthOverride(options.width ?? null);
  if (options.plain != null) setCliPlainOverride(options.plain);
  const commandArgs = foldCommandArgs(versionCommand, parsed.args.slice(1), parsed.literalStart - 1);
  try {
    if (parsed.help) {
      if (options.format === "text") {
        if (!options.quiet) process.stdout.write(`${renderCommandHelp(versionCommand)}\n`);
      } else {
        printCliResult({ data: { ...describeCliCommand(versionCommand), sections: versionCommand.help?.sections ?? [] } }, options);
      }
    } else {
      checkCliCommandOptions(versionCommand, commandArgs, parsed.literalStart - 1);
      await printVersion((result, renderOptions) => printCliResult(result, options, renderOptions, commandArgs));
    }
  } catch (error) {
    printCliError(error, options, { command: versionCommand.name, args: commandArgs });
    process.exitCode = 1;
  }
  return true;
}
