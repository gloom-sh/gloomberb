import { seriesExpression } from "../series/registry";
import type { SeriesDefinition } from "../series/types";
import { cliStyles, renderSection, renderTable, wrapText } from "../utils/cli-output";
import { currencyCodeLabel } from "../utils/currency-units";

/** A data catalog series a query names, as the CLI lists it. */
export interface SeriesMatch {
  id: string;
  name: string;
  unit: string;
  frequency: string;
  publisher: string | null;
  /** What `fn G` charts. */
  expression: string;
  /** The query is the series' name or one of its tags, not just words found in them. */
  exact: boolean;
}

interface SeriesSource {
  series?: readonly SeriesDefinition[];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The FRED series id a chart expression names (`FRED:DFEDTARU` is DFEDTARU), else null. */
function fredSeriesIdOf(expression: string): string | null {
  return /^FRED:([A-Z0-9]+)$/i.exec(expression)?.[1]?.toUpperCase() ?? null;
}

/** The FRED series the plugins' catalog charts, as `gloomberb fred` takes them: DFEDTARU, ECBDFR. */
export function catalogFredSeriesIds(plugins: readonly SeriesSource[]): Set<string> {
  return new Set(plugins.flatMap((plugin) => plugin.series ?? [])
    .flatMap((definition) => definition.expression ? [fredSeriesIdOf(definition.expression)] : [])
    .filter((id): id is string => id !== null));
}

/** Each word must start a word of the text, so "eu" finds "Europe" but not "neutral". */
const startsWord = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${escape(word)}`).test(text);

/**
 * The plugins' catalog series whose words cover every word of the query: in
 * the name and tags only for `search`, also the description and publisher for
 * `catalog`. Series that ask for a ticker are left out; a search names data,
 * not a field of every stock. A query that is a series' id (`policy-rate:ch`),
 * what `fn G` charts (`CAP:policy-rate:ch`, `FRED:DFEDTARU`) or a FRED series
 * id (`DFEDTARU`) ranks it first, then one that is its name or tag, then
 * matches in the name, then the order the series were registered in.
 */
export function findCatalogSeries(
  plugins: readonly SeriesSource[],
  query: string,
  scope: "names" | "all" = "all",
): SeriesMatch[] {
  const words = query.toLowerCase().replace(/["']/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.join("").length < 3) return [];
  const phrase = words.join(" ");
  const ranked: Array<{ match: SeriesMatch; score: number; order: number }> = [];
  for (const definition of plugins.flatMap((plugin) => plugin.series ?? [])) {
    if (definition.input) continue;
    const expression = seriesExpression(definition);
    const byId = words.length === 1
      && [definition.id, expression, fredSeriesIdOf(expression) ?? ""].some((id) => id.toLowerCase() === phrase);
    const name = definition.name.toLowerCase();
    const text = [name, ...(definition.tags ?? []), definition.group ?? "",
      ...(scope === "all" ? [definition.description ?? "", definition.publisher ?? ""] : [])].join(" ").toLowerCase();
    if (!byId && !words.every((word) => startsWord(text, word))) continue;
    const exact = byId || name === phrase || (definition.tags ?? []).some((tag) => tag.toLowerCase() === phrase);
    ranked.push({
      match: { id: definition.id, name: definition.name, unit: definition.unit, frequency: definition.frequency,
        publisher: definition.publisher ?? null, expression, exact },
      score: (byId ? 100 : 0) + (exact ? words.length + 1 : 0) + words.filter((word) => startsWord(name, word)).length,
      order: ranked.length,
    });
  }
  return ranked.sort((left, right) => right.score - left.score || left.order - right.order).map(({ match }) => match);
}

/** A chart expression as a shell takes it: a formula (`42*HO=F - CL=F`) in double quotes. */
function shellArgument(expression: string): string {
  return /[\s*()&|;<>$`'"\\!?[\]{}#~]/.test(expression) ? `"${expression.replace(/(["\\$`])/g, "\\$1")}"` : expression;
}

/**
 * The series part of `catalog` or `search`: a table of the first `limit`
 * matches with the expression `fn G` charts, and how to see the rest.
 */
export function renderSeriesMatches(
  query: string,
  matches: readonly SeriesMatch[],
  limit: number,
  width: number,
  /** Where the rest are listed: `shot CAT` from the catalog, the catalog from a search. */
  rest: "catalog" | "data-catalog" = "data-catalog",
): string {
  if (matches.length === 0) return "";
  const shown = matches.slice(0, limit);
  const count = shown.length < matches.length ? `${shown.length} of ${matches.length}` : String(matches.length);
  const quoted = `"${query.replace(/"/g, "")}"`;
  // A FRED series named by its id is also one `gloomberb fred` prints.
  const asked = query.trim().toUpperCase().replace(/^FRED:/, "");
  const fred = matches.find((match) => match.exact && fredSeriesIdOf(match.expression) === asked);
  const hint = fred
    ? `Print it with gloomberb fred ${asked}; chart it with gloomberb fn G ${fred.expression}.`
    : shown.length < matches.length
    ? `Chart one with gloomberb fn G <chart>; gloomberb ${rest === "catalog" ? `catalog ${quoted}` : `shot CAT ${quoted}`} lists all ${matches.length}.`
    : "Chart one with gloomberb fn G <chart>.";
  return [
    `${renderSection(`Series for "${query}"`)} ${cliStyles.muted(`(${count})`)}`,
    renderTable(
      [{ header: "Series" }, { header: "Unit" }, { header: "Frequency", optional: true }, { header: "Publisher", optional: true },
        { header: "Chart", shrink: false }],
      shown.map((match) => [match.name, currencyCodeLabel(match.unit), match.frequency, match.publisher ?? "", cliStyles.command(shellArgument(match.expression))]),
    ),
    "",
    ...wrapText(hint, width).map((line) => cliStyles.muted(line)),
  ].join("\n");
}
