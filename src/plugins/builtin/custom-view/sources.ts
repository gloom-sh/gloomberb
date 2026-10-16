/**
 * The functions a custom view can read: every pane or template with a headless
 * loader, listed from the registry itself so a new function reaches the
 * assistant's tool text and the unknown-source error without anyone naming it.
 */

import type { PaneFunctionCatalog } from "../../../cli/pane-functions/catalog";
import type { HeadlessPaneArgumentDef, HeadlessPaneOptionDef } from "../../../types/headless";

export type ViewSourceCatalog = Pick<PaneFunctionCatalog, "panes" | "paneTemplates">;

export interface ViewSourceInfo {
  /** What `source.pane` takes: the function code the person types, or the pane id. */
  token: string;
  label: string;
  argument: HeadlessPaneArgumentDef;
  options: readonly HeadlessPaneOptionDef[];
  /** Keywords, aliases and the pane's own name: other things people call the function. */
  keywords: string[];
}

/** Closest sources an unknown name is answered with. */
const NEAR_SOURCE_LIMIT = 5;

/** Same sources as the assistant's function tools: templates first, then panes no template covers. */
export function listViewSources(catalog: ViewSourceCatalog): ViewSourceInfo[] {
  const sources: ViewSourceInfo[] = [];
  const templated = new Set<string>();
  for (const template of catalog.paneTemplates.values()) {
    const pane = catalog.panes.get(template.paneId);
    if (!pane) continue;
    templated.add(pane.id);
    const headless = template.headless ?? pane.headless;
    if (!headless) continue;
    sources.push({
      token: template.shortcut?.prefix ?? template.id,
      label: template.label,
      argument: headless.argument,
      options: headless.options,
      keywords: [...(template.keywords ?? []), ...(template.shortcut?.aliases ?? []), pane.name],
    });
  }
  for (const pane of catalog.panes.values()) {
    if (templated.has(pane.id) || !pane.headless) continue;
    sources.push({
      token: pane.id,
      label: pane.name,
      argument: pane.headless.argument,
      options: pane.headless.options,
      keywords: [],
    });
  }
  return sources.sort((left, right) => (left.token < right.token ? -1 : left.token > right.token ? 1 : 0));
}

/** What a source takes after its code, in the order the groups are listed. */
const ARGUMENT_GROUPS = ["no argument", "one ticker", "tickers", "text", "optional text"] as const;

function argumentGroup({ kind, optional }: HeadlessPaneArgumentDef): (typeof ARGUMENT_GROUPS)[number] {
  switch (kind) {
    case "none":
      return "no argument";
    case "ticker":
      return "one ticker";
    case "tickers":
    case "symbol-list":
      return "tickers";
    case "free-text":
      return optional ? "optional text" : "text";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** The source codes grouped by what they take after the code: `no argument: A, B; one ticker: C`. */
function describeViewSourceGroups(sources: readonly ViewSourceInfo[]): string {
  return ARGUMENT_GROUPS
    .map((group) => ({ group, tokens: sources.filter((source) => argumentGroup(source.argument) === group).map((source) => source.token) }))
    .filter(({ tokens }) => tokens.length > 0)
    .map(({ group, tokens }) => `${group}: ${tokens.join(", ")}`)
    .join("; ");
}

/**
 * What the assistant's view tools say about their sources: the codes by the
 * argument each takes, and how options are written. An empty catalog says
 * nothing, so a host with no functions never advertises any.
 */
export function describeViewSources(catalog: ViewSourceCatalog): string {
  const sources = listViewSources(catalog);
  if (sources.length === 0) return "";
  return `source.pane is one of these function codes, never an invented name, by what each takes as argument (always one string, several tickers separated by spaces: "CME AAPL"): ${describeViewSourceGroups(sources)}. `
    + "options sets the function's own flags as { flag: value }; a wrong flag or value is answered with the ones it takes.";
}

function nameWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 2);
}

function wordMatches(word: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => candidate.startsWith(word) || (candidate.length >= 4 && word.startsWith(candidate)));
}

/** The sources whose code, name or keywords share a word with what was typed, best first. */
export function nearViewSources(sources: readonly ViewSourceInfo[], name: string): ViewSourceInfo[] {
  const typed = nameWords(name).filter((word) => word.length >= 3);
  const joined = typed.join("");
  if (typed.length === 0) return [];
  return sources
    .map((source) => {
      const token = source.token.toLowerCase();
      const tokenWords = nameWords(source.token);
      const keywords = nameWords(source.keywords.join(" "));
      let score = token.length >= 3 && (token.startsWith(joined) || joined.startsWith(token)) ? 12 : 0;
      for (const word of typed) {
        if (wordMatches(word, tokenWords)) score += 8;
        else if (wordMatches(word, nameWords(source.label))) score += 6;
        else if (wordMatches(word, keywords)) score += 3;
      }
      return { source, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || (left.source.token < right.source.token ? -1 : 1))
    .slice(0, NEAR_SOURCE_LIMIT)
    .map(({ source }) => source);
}

/** The answer to a `source.pane` that opens nothing: the nearest functions, then every valid source. */
export function unknownViewSourceMessage(catalog: ViewSourceCatalog, name: string): string {
  const sources = listViewSources(catalog);
  const near = nearViewSources(sources, name);
  return [
    `Unknown source "${name}".`,
    near.length > 0 ? `Closest: ${near.map((source) => `${source.token} (${source.label})`).join(", ")}.` : "",
    sources.length > 0 ? `Valid sources, by what each takes as argument: ${describeViewSourceGroups(sources)}.` : "",
  ].filter(Boolean).join(" ");
}

/** A source that is a pane but not a data function: the valid ones, so the next try names one. */
export function notViewSourceMessage(catalog: ViewSourceCatalog, label: string): string {
  const sources = listViewSources(catalog);
  return [
    `${label} has no data function to build a view from.`,
    sources.length > 0 ? `Valid sources, by what each takes as argument: ${describeViewSourceGroups(sources)}.` : "",
  ].filter(Boolean).join(" ");
}
