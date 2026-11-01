import type { CliCommandDef } from "../types/plugin";
import { foldTypedText } from "../utils/typed-text";
import { fail } from "./errors";
import { suggestCliOption } from "./help";

/** A built-in command, which may say more about an option it does not take than the list of those it does. */
export interface BuiltinCliCommandDef extends CliCommandDef {
  /**
   * A sentence for an unknown option people reach for, such as `--from` on
   * `history`; null for the rest. `args` are the command's, to name what it was given.
   */
  unknownOptionHint?(flag: string, args: readonly string[]): string | null;
  /**
   * Whether the argument at `index` of the command's positional arguments
   * (options and their values left out) is taken exactly as typed: a path, a
   * note's text, JSON. Every other argument is folded (`foldCommandArgs`).
   */
  keepsArgAsTyped?(positionals: readonly string[], index: number): boolean;
}

interface DeclaredOption {
  flag: string;
  takesValue: boolean;
  /** The value names a file or a folder (`--file <path>`), which folding would rename. */
  path: boolean;
}

/** A value placeholder that names a file or a folder. */
const PATH_VALUE = /<(?:path|file|dir)>/i;
/** Options whose value is a path on every command, including those that take any option (`fn`, `shot`). */
const PATH_OPTIONS = new Set(["--file", "--output", "--out"]);

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
      if (match) declared.set(match[1]!, { flag: match[1]!, takesValue: match[2] != null, path: PATH_VALUE.test(match[2] ?? "") });
    }
  }
  return declared;
}

/** `--explain` on a command that has no glossary of its own points at the commands that do, and at the glossary. */
const EXPLAIN_HINT = "--explain follows the reports of fn <function> and portfolio show. "
  + "gloom catalog explain <term> prints what one term means; gloom catalog glossary lists every term.";

/** Options people reach for to see a price in another currency, which no command takes: `fx` converts. */
const CURRENCY_OPTIONS = new Set(["--currency", "--ccy", "--cur", "--convert", "--fx", "--to-currency", "--in-currency"]);

/**
 * `quote SBLK --currency EUR`: prices are in each listing's currency, and
 * `fx` converts an amount, so the error names it, with the code given.
 */
function currencyOptionHint(flag: string, args: readonly string[]): string | null {
  if (!CURRENCY_OPTIONS.has(flag)) return null;
  const at = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const typed = (args[at]?.includes("=") ? args[at]!.slice(flag.length + 1) : args[at + 1] ?? "").trim().toUpperCase();
  const code = /^[A-Z]{3}$/.test(typed) ? typed : "EUR";
  return `Prices are in each listing's own currency. To convert an amount, use fx: gloom fx 100 USD/${code}.`;
}

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
    command.unknownOptionHint?.(flag, args) ?? currencyOptionHint(flag, args) ?? (flag === "--explain" ? EXPLAIN_HINT : ""),
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

/**
 * A command's arguments as its lookups read them: each folded once, here,
 * before any symbol, number, date or search reads it (`foldTypedText`), so
 * `quote ＧＭＥ`, `--date ２０２６-１０-１３` and `fn SIW "ＧＭＥ　AMC"` read as
 * typed in ASCII. A path (`--file <path>`, `--output`) and what the command
 * keeps as typed (`keepsArgAsTyped`: a note's text, JSON) are left alone.
 */
export function foldCommandArgs(
  command: BuiltinCliCommandDef,
  args: readonly string[],
  literalStart = args.length,
): string[] {
  const declared = declaredOptions(command);
  const asTyped = new Set<number>();
  const positionals: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (index >= literalStart || !OPTION_TOKEN.test(arg)) {
      positionals.push(index);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals >= 0 ? arg.slice(0, equals) : arg;
    const option = declared?.get(flag);
    const path = option?.path || PATH_OPTIONS.has(flag);
    if (equals >= 0) {
      if (path) asTyped.add(index);
    } else if (option?.takesValue || path) {
      if (path) asTyped.add(index + 1);
      index += 1;
    }
  }
  if (command.keepsArgAsTyped) {
    const words = positionals.map((index) => foldTypedText(args[index]!));
    positionals.forEach((index, at) => {
      if (command.keepsArgAsTyped!(words, at)) asTyped.add(index);
    });
  }
  return args.map((arg, index) => asTyped.has(index) ? arg : foldTypedText(arg));
}
