import type { CliCommandDef } from "../types/plugin";
import {
  cliStyles,
  cliTerminalWidth,
  renderDefinitions,
  renderSection,
  renderTable,
  visibleLength,
  wrapCommandLine,
  wrapText,
} from "../utils/cli-output";

/** Headings of `gloomberb help`, in display order. */
export const CLI_COMMAND_GROUPS = {
  research: "Research",
  companyData: "Company data",
  markets: "Markets",
  functions: "Functions",
  portfolios: "Portfolios",
  plugins: "Plugins",
  app: "App",
} as const;

const PLUGIN_COMMANDS_GROUP = "Plugin commands";
const OTHER_GROUP = "Other";
const INDENT = 2;
// Help reads best as a column of text, so wide terminals still wrap here.
const MAX_HELP_WIDTH = 100;
const PIPED_HELP_WIDTH = 80;

const GLOBAL_OPTIONS: Array<[string, string]> = [
  ["--json, --csv, --ndjson", "Print machine-readable output instead of text"],
  ["--limit <n>", "Show at most n rows"],
  ["--refresh", "Fetch fresh data instead of reading the cache"],
  ["--dry-run", "Preview config, cache, notes, alerts, plugin on/off, and remote changes without saving"],
  ["-q, --quiet", "Print no results or errors in text mode, for commands that print results"],
  ["--color, --no-color", "Force or turn off colors (NO_COLOR=1 also turns them off)"],
];

export interface CliHelpEntry {
  command: CliCommandDef;
  source: "core" | "plugin";
}

function helpWidth(): number {
  return Math.min(cliTerminalWidth() ?? PIPED_HELP_WIDTH, MAX_HELP_WIDTH);
}

function commandGroup(entry: CliHelpEntry): string {
  return entry.command.help?.group ?? (entry.source === "plugin" ? PLUGIN_COMMANDS_GROUP : OTHER_GROUP);
}

function withProgramName(invocation: string): string {
  return invocation.startsWith("gloomberb ") ? invocation : `gloomberb ${invocation}`;
}

function renderInvocation(invocation: string, width: number): string[] {
  return wrapCommandLine(withProgramName(invocation), width, INDENT);
}

function renderParagraph(text: string, width: number): string[] {
  return wrapText(text, width - INDENT).map((line) => `${" ".repeat(INDENT)}${line}`.trimEnd());
}

function groupCliHelpEntries(entries: CliHelpEntry[]): Array<{ title: string; entries: CliHelpEntry[] }> {
  const knownOrder: string[] = Object.values(CLI_COMMAND_GROUPS);
  const groups = new Map<string, CliHelpEntry[]>();
  for (const entry of entries) {
    const title = commandGroup(entry);
    groups.set(title, [...(groups.get(title) ?? []), entry]);
  }
  const rank = (title: string) => {
    const known = knownOrder.indexOf(title);
    if (known >= 0) return known;
    // Groups a plugin invents sit after the built-in ones, with ungrouped commands last.
    if (title === PLUGIN_COMMANDS_GROUP) return knownOrder.length + 2;
    if (title === OTHER_GROUP) return knownOrder.length + 1;
    return knownOrder.length;
  };
  return [...groups.entries()]
    .map(([title, groupEntries]) => ({ title, entries: groupEntries }))
    .sort((left, right) => rank(left.title) - rank(right.title));
}

export function renderCliHelp(entries: CliHelpEntry[], version: string, description: string): string {
  const width = helpWidth();
  const listed = entries.filter(({ command }) => command.name !== "help");
  const nameWidth = Math.max(0, ...listed.map(({ command }) => visibleLength(command.name)));
  const lines = [
    `${cliStyles.bold("gloomberb")} ${cliStyles.muted(version)}`,
    ...wrapText(description, width),
    "",
    renderSection("Usage"),
    ...renderDefinitions([
      ["gloomberb", "Open the terminal UI"],
      ["gloomberb <command> [args]", "Run a command and print the result"],
      ["gloomberb help <command>", "Show a command's usage, options, and examples"],
    ], { width }),
  ];

  for (const group of groupCliHelpEntries(listed)) {
    lines.push("", renderSection(group.title));
    lines.push(...renderDefinitions(
      group.entries.map(({ command }) => [command.name, command.description]),
      { width, termStyle: cliStyles.command, termWidth: nameWidth },
    ));
  }

  lines.push("", renderSection("Global options"));
  lines.push(...renderDefinitions(GLOBAL_OPTIONS, { width, termStyle: cliStyles.command }));
  return lines.join("\n");
}

export function renderCommandHelp(command: CliCommandDef): string {
  const width = helpWidth();
  const help = command.help ?? {};
  const usage = help.usage?.length ? help.usage : [command.name];
  const lines = [
    ...wrapText(command.description, width),
    "",
    renderSection("Usage"),
    ...usage.flatMap((line) => renderInvocation(line, width)),
  ];

  if (command.aliases?.length) {
    lines.push("", renderSection("Aliases"), ...renderParagraph(command.aliases.join(", "), width));
  }

  if (help.options?.length) {
    lines.push("", renderSection("Options"));
    lines.push(...renderDefinitions(
      help.options.map((option) => [option.flags, option.description]),
      { width, termStyle: cliStyles.command },
    ));
  }

  for (const section of help.sections ?? []) {
    lines.push("", renderSection(section.title));
    for (const line of section.lines ?? []) lines.push(...renderParagraph(line, width));
    if (section.columns && section.rows) {
      // Reference tables show every value, even past the terminal width.
      lines.push(renderTable(section.columns, section.rows, { indent: INDENT, maxWidth: null }));
    }
  }

  if (help.examples?.length) {
    lines.push("", renderSection("Examples"));
    lines.push(...help.examples.flatMap((example) => renderInvocation(example, width)));
  }

  return lines.join("\n");
}

export function describeCliCommand(command: CliCommandDef) {
  // The first four keys predate groups, options, and examples; exports keep that order.
  return {
    name: command.name,
    aliases: command.aliases ?? [],
    description: command.description,
    usage: command.help?.usage ?? [],
    group: command.help?.group ?? null,
    options: command.help?.options ?? [],
    examples: command.help?.examples ?? [],
  };
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** The closest command token to a mistyped one, or null when nothing is plausibly meant. */
export function suggestCliCommand(token: string, candidates: Iterable<string>): string | null {
  const needle = token.trim().toLowerCase();
  if (!needle || needle.startsWith("-")) return null;
  const allowed = needle.length <= 4 ? 1 : 2;
  let best: { name: string; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.startsWith("-")) continue;
    // A clear prefix ("tick" for "ticker") beats an edit of the same size.
    const score = needle.length >= 3 && candidate.startsWith(needle)
      ? 0.5
      : editDistance(needle, candidate);
    if (score > allowed) continue;
    if (!best || score < best.score) best = { name: candidate, score };
  }
  return best?.name ?? null;
}
