import { commandWord } from "../utils/shell-word";

/** Spreadsheet formats people ask for by name, which no command writes: CSV is the one a spreadsheet opens. */
const SPREADSHEET_OPTIONS = new Set(["--xlsx", "--xls", "--excel", "--spreadsheet", "--sheet", "--sheets", "--tsv"]);

/** A file named after a spreadsheet flag (`--xlsx rates.xlsx`), which becomes the CSV's name. */
const SPREADSHEET_FILE = /\.(xlsx|xls|tsv)$/i;

/** An argument as a shell reads it back: quoted when it holds a space or a character the shell acts on; `"^TNX"` for cmd.exe. */
function shellWord(arg: string): string {
  if (!/^[\w^=.,:/@%+-]+$/.test(arg)) return `'${arg.replaceAll("'", "'\\''")}'`;
  return arg.includes("^") ? commandWord(arg) : arg;
}

/**
 * `quote ^TNX --xlsx`: the error names the formats there are, and the one a
 * spreadsheet opens, as the command that was typed (`command`, the words
 * before its arguments: `quote`, `fn QQ`) with `--csv` in place of the flag.
 * `args` are what followed it; a file named after the flag keeps its name as a
 * `.csv`, else the file is named after the command or the function.
 */
export function spreadsheetOptionHint(flag: string, command: string, args: readonly string[] = []): string | null {
  const name = flag.split("=")[0]!.toLowerCase();
  if (!SPREADSHEET_OPTIONS.has(name)) return null;
  let file: string | null = null;
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [argFlag, value] = arg.split(/=(.*)/s, 2);
    if (argFlag!.toLowerCase() !== name) {
      kept.push(arg);
      continue;
    }
    const next = args[index + 1];
    if (value && SPREADSHEET_FILE.test(value)) file = value;
    else if (next && SPREADSHEET_FILE.test(next)) {
      file = next;
      index += 1;
    }
  }
  const words = [...command.trim().split(/\s+/), ...kept.filter((arg) => arg !== "--csv")];
  // Named after the command, a function by its code (`fn QQ`: qq.csv).
  const named = command.trim().split(/\s+/).filter((word, index) => index > 0 || word !== "fn");
  const output = file ? file.replace(SPREADSHEET_FILE, ".csv") : `${named.join("-").toLowerCase()}.csv`;
  return `Exports are --csv (opens in Excel and Google Sheets), --json or --ndjson: gloom ${words.map(shellWord).join(" ")} --csv > ${shellWord(output)}.`;
}
