import { typoDistance } from "../../utils/typo-distance";
import { findCapabilityOption } from "./capabilities";
import type { ResolvedPaneFunction } from "./resolver";

/** An argument as a shell reads it back: bare when it is one word, in quotes when it is not. */
function shellWord(value: string): string {
  return /^[\w.:,=%+@/$^-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * What the CLI's own row options do to printed output, which no pane draws:
 * a function that declares one reads it through its option, and one that
 * does not is told so by `fn` (`HP does not support --tail`).
 */
const GLOBAL_ROW_OPTIONS: Record<string, string> = {
  limit: "cuts a printed table to its first rows",
  tail: "keeps a printed table's newest rows",
};

/** `fn`'s output options, which pick printed text; `shot` saves no text. */
const REPORT_OUTPUT_OPTIONS: Record<string, { does: string; run: string }> = {
  explain: { does: "follows a report's text with the terms it shows", run: "--explain" },
  section: { does: "picks one table of a report's --csv or --ndjson", run: "--csv --section" },
};

/**
 * Why `shot` cannot draw an option it was given, or null when the pane draws
 * them all. An option only the report reads (`shot.reportOnly`, `--limit`'s
 * rows of text) is refused rather than captured as the pane's default and
 * reported complete, with the `fn` command that reads it; so are the CLI's
 * row options on a function that has no option of that name (`--tail` on
 * HP), `fn`'s output options (`--explain`, `--section`), and a slip of an
 * option's name (`--veiw`). Any other key is a pane setting, which a capture
 * takes as before. Options left at their defaults are not asked for, so
 * never refused.
 */
export function shotOptionRefusal(
  resolved: Pick<ResolvedPaneFunction, "token" | "capability">,
  rawArgument: string,
  options: Record<string, string | true>,
  { explain = false }: { explain?: boolean } = {},
): string | null {
  const report = (...flags: string[]) => ["gloomberb fn", resolved.token, rawArgument.trim() && shellWord(rawArgument.trim()), ...flags]
    .filter(Boolean).join(" ");
  const given: Array<[string, string | true]> = [...explain ? [["explain", true] as [string, true]] : [], ...Object.entries(options)];
  for (const [key, value] of given) {
    const option = findCapabilityOption(resolved.capability, key);
    if (option?.shot) {
      return `${resolved.token}'s pane does not draw --${option.key}: it ${option.shot.reportOnly}. Drop it from shot, or run the report: ${report(`--${option.key}`, value === true ? "" : shellWord(value))}`;
    }
    if (option) continue;
    const row = GLOBAL_ROW_OPTIONS[key];
    if (row) {
      // `fn` refuses it too, so there is no report to point to.
      return `${resolved.token} has no --${key}: it ${row}, and neither ${resolved.token}'s pane nor its report has one. Drop it from shot.`;
    }
    const output = REPORT_OUTPUT_OPTIONS[key];
    if (output) {
      return `shot saves no report text, and --${key} ${output.does}. Drop it from shot, or run the report: ${report(output.run, value === true ? "" : shellWord(value))}`;
    }
    if (key.length < 3) continue;
    const meant = resolved.capability.options.find((entry) => (
      [entry.key, ...entry.aliases ?? []].some((name) => typoDistance(name.toLowerCase(), key.toLowerCase()) <= 1)
    ));
    if (meant) return `${resolved.token} has no --${key}. Did you mean --${meant.key}?`;
  }
  return null;
}
