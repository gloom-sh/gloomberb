import type { CliCommandDef } from "../types/plugin";
import { fail } from "./errors";
import { suggestCliOption } from "./help";

/** A built-in command, which may say more about an option it does not take than the list of those it does. */
export interface BuiltinCliCommandDef extends CliCommandDef {
  /**
   * A sentence for an unknown option people reach for, such as `--from` on
   * `history`; null for the rest. `args` are the command's, to name what it was given.
   */
  unknownOptionHint?(flag: string, args: readonly string[]): string | null;
}

interface DeclaredOption {
  flag: string;
  takesValue: boolean;
}

/** `--range`, `--range=5Y`: an option. `-5`, `---`, `--` and plain words are not. */
const OPTION_TOKEN = /^--[a-z]/i;

/**
 * The options a command's help declares, from each spelling such as
 * `--range <range>` (takes a value) or `--all` (a switch). Null when it takes
 * any option: `--<option> <value>` on `fn` and `shot`.
 */
function declaredOptions(command: CliCommandDef): Map<string, DeclaredOption> | null {
  const declared = new Map<string, DeclaredOption>();
  for (const option of command.help?.options ?? []) {
    for (const spelling of option.flags.split(",")) {
      const trimmed = spelling.trim();
      if (trimmed.startsWith("--<")) return null;
      const match = /^(--?[a-z][\w-]*)(?:[ =](.+))?$/i.exec(trimmed);
      if (match) declared.set(match[1]!, { flag: match[1]!, takesValue: match[2] != null });
    }
  }
  return declared;
}

/** `--explain` on a command that has no glossary of its own points at the commands that do, and at the glossary. */
const EXPLAIN_HINT = "--explain follows the reports of fn <function> and portfolio show. "
  + "gloom catalog explain <term> prints what one term means; gloom catalog glossary lists every term.";

function failUnknownOption(
  command: BuiltinCliCommandDef,
  flag: string,
  declared: Map<string, DeclaredOption>,
  args: readonly string[],
): never {
  const flags = [...declared.keys()];
  const suggestion = suggestCliOption(flag, flags);
  const help = `See gloom help ${command.name}.`;
  fail(`Unknown option ${flag} for ${command.name}.`, [
    command.unknownOptionHint?.(flag, args) ?? (flag === "--explain" ? EXPLAIN_HINT : ""),
    suggestion ? `Did you mean ${suggestion}?` : "",
    flags.length > 0 ? `Options: ${flags.join(", ")}. ${help}` : `${command.name} takes no options. ${help}`,
  ].filter(Boolean).join("\n"));
}

/**
 * Fails on the first `--option` a built-in command does not declare, which it
 * would otherwise ignore and answer as if it had not been given: `history
 * --from 1995-01-01` printing the default year. Global flags are already out
 * of `args`; a declared option's value is skipped whatever it looks like, and
 * nothing from `literalStart` on (after a bare `--`) is read as an option.
 */
export function checkCliCommandOptions(
  command: BuiltinCliCommandDef,
  args: readonly string[],
  literalStart = args.length,
): void {
  const declared = declaredOptions(command);
  if (!declared) return;
  for (let index = 0; index < Math.min(literalStart, args.length); index += 1) {
    const arg = args[index]!;
    if (!OPTION_TOKEN.test(arg)) continue;
    const equals = arg.indexOf("=");
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const option = declared.get(flag);
    if (!option) failUnknownOption(command, flag, declared, args);
    if (!option.takesValue && equals >= 0) {
      fail(`${flag} takes no value.`, `Write it alone, as ${flag}. See gloom help ${command.name}.`);
    }
    if (option.takesValue && equals < 0) index += 1;
  }
}
