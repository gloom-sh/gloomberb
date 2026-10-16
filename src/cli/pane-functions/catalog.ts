import { commands as builtInCommands, getCommandPrefixes } from "../../components/command-bar/commands/registry";
import type { PaneDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import {
  buildCreateOptions,
  normalizeLookupToken,
  type ParsedPaneCatalogArgs,
} from "./options";
import {
  getHeadlessPaneDefinition,
  getPaneFunctionCapability,
  type PaneFunctionCapability,
  type PaneFunctionOptionDef,
  type PaneFunctionReadiness,
} from "./capabilities";
import {
  cliStyles,
  cliTerminalWidth,
  renderDefinitions,
  renderSection,
  renderStats,
  renderTable,
  wrapCommandLine,
  wrapText,
  type CliStatEntry,
} from "../../utils/cli-output";
import { renderGlossaryEntries, type GlossaryLookup } from "../glossary";
import { renderSeriesMatches, type SeriesMatch } from "../series-search";
import { typoDistance } from "../../utils/typo-distance";

export interface PaneFunctionCatalog {
  panes: ReadonlyMap<string, PaneDef>;
  paneTemplates: ReadonlyMap<string, PaneTemplateDef>;
  destroy(): void;
}

export interface PaneCatalogEntry {
  token: string;
  label: string;
  description: string;
  paneId: string;
  paneName: string;
  templateId?: string;
  shortcut?: string;
  /** Other mnemonics that open the same function (IMAP for BI). */
  aliases: string[];
  argKind?: string;
  argPlaceholder?: string;
  keywords: string[];
  defaultSettings: Record<string, unknown>;
  capability: PaneFunctionCapability;
}

export function buildTemplateContext(context: MarketContext, symbol: string | null) {
  return {
    config: context.config,
    layout: context.config.layout,
    focusedPaneId: null,
    activeTicker: symbol,
    activeCollectionId: null,
  };
}

/**
 * The command-bar mnemonic and aliases of a pane that has no template but is
 * opened by the built-in command of the same id (HELP, LAY).
 */
function builtInPanePrefixes(paneId: string): string[] {
  const command = builtInCommands.find((candidate) => candidate.id === paneId);
  return command ? getCommandPrefixes(command) : [];
}

function registerResolverToken(
  lookup: Map<string, PaneTemplateDef | PaneDef>,
  token: string | undefined,
  value: PaneTemplateDef | PaneDef,
) {
  if (!token) return;
  const normalized = normalizeLookupToken(token);
  if (!normalized || lookup.has(normalized)) return;
  lookup.set(normalized, value);
}

export function buildPaneFunctionLookup(registry: PaneFunctionCatalog): Map<string, PaneTemplateDef | PaneDef> {
  const lookup = new Map<string, PaneTemplateDef | PaneDef>();
  // Shortcut prefixes first: "AI" must open the pane that owns the shortcut, not
  // one that happens to list "ai" as a keyword.
  for (const template of registry.paneTemplates.values()) {
    registerResolverToken(lookup, template.shortcut?.prefix, template);
  }
  for (const template of registry.paneTemplates.values()) {
    for (const alias of template.shortcut?.aliases ?? []) registerResolverToken(lookup, alias, template);
  }
  for (const pane of registry.panes.values()) {
    for (const prefix of builtInPanePrefixes(pane.id)) registerResolverToken(lookup, prefix, pane);
  }
  for (const template of registry.paneTemplates.values()) {
    registerResolverToken(lookup, template.id, template);
    registerResolverToken(lookup, template.label, template);
    for (const keyword of template.keywords ?? []) registerResolverToken(lookup, keyword, template);
  }

  for (const pane of registry.panes.values()) {
    registerResolverToken(lookup, pane.id, pane);
    registerResolverToken(lookup, pane.name, pane);
  }

  for (const template of registry.paneTemplates.values()) {
    const pane = registry.panes.get(template.paneId);
    if (!pane) continue;
    const discovery = getHeadlessPaneDefinition(template, pane)?.discovery;
    registerResolverToken(lookup, discovery?.id, template);
    for (const alias of discovery?.aliases ?? []) registerResolverToken(lookup, alias, template);
  }

  return lookup;
}

/** What a function takes after its code, as the catalog writes it: `<ticker>`, `<fund, ticker, or CIK>`, or nothing. */
function argumentHint({ argKind, argPlaceholder }: Pick<PaneCatalogEntry, "argKind" | "argPlaceholder">): string {
  if (argPlaceholder) return `<${argPlaceholder}>`;
  return argKind && argKind !== "none" ? `<${argKind}>` : "";
}

/** A command-line token that is the code or an alias of a function, with what the function takes. */
export interface FunctionCode {
  argument: string;
}

/**
 * Whether `token` is the code or an alias of a function (`OVDV`, `EEO`), in any
 * case: the function `fn` opens for it, not one it merely matches by a keyword
 * or a label.
 */
export function findFunctionCode(registry: PaneFunctionCatalog, token: string): FunctionCode | null {
  const wanted = normalizeLookupToken(token);
  const found = wanted ? buildPaneFunctionLookup(registry).get(wanted) : undefined;
  if (!found || !("paneId" in found && "description" in found)) return null;
  const pane = registry.panes.get(found.paneId);
  const headless = pane ? getHeadlessPaneDefinition(found, pane) : undefined;
  const codes = [
    found.shortcut?.prefix,
    ...(found.shortcut?.aliases ?? []),
    headless?.discovery?.id,
    ...(headless?.discovery?.aliases ?? []),
  ];
  if (!codes.some((code) => code && normalizeLookupToken(code) === wanted)) return null;
  return {
    argument: argumentHint({
      argKind: headless?.argument.kind ?? found.shortcut?.argKind,
      argPlaceholder: headless?.argument.placeholder ?? found.shortcut?.argPlaceholder,
    }),
  };
}

/** A function code a typed one is a slip away from: what to type, and the function's name. */
export interface NearFunctionCode {
  code: string;
  label: string;
}

/** Typed names shorter than this are too short for one slip to leave them recognisable (`HQ` is a slip from a dozen codes). */
const MIN_CODE_TYPO_LENGTH = 3;
/**
 * A word typed as a command is as likely a ticker as a slip from a code
 * (`PLTR`, `META`, `QQQ`): it is read as a slip only from this length and
 * when its first letter is the code's.
 */
const MIN_COMMAND_WORD_TYPO_LENGTH = 4;
/** Near codes an unknown one is answered with; more than this many is no suggestion. */
const NEAR_CODE_LIMIT = 3;

/**
 * The function codes one slip of the keys from a name that opens no function
 * (a letter swapped, missing, extra or wrong: `RCDF` for RDCF, `HPP` for HP),
 * among the mnemonics the command bar takes, each named by the code it is
 * near (`DES` for Ticker Research, whose code is T). Empty when none is that
 * close, the name is too short to tell, or so many are that none stands out.
 * A word typed as a command (`commandWord`, `gloomberb RCDF PLTR`) is held to
 * MIN_COMMAND_WORD_TYPO_LENGTH and the code's first letter, so a ticker typed
 * there is not taken for a code.
 */
export function nearFunctionCodes(
  registry: PaneFunctionCatalog,
  name: string,
  { commandWord = false }: { commandWord?: boolean } = {},
): NearFunctionCode[] {
  const wanted = normalizeLookupToken(name);
  if (wanted.length < (commandWord ? MIN_COMMAND_WORD_TYPO_LENGTH : MIN_CODE_TYPO_LENGTH)) return [];
  const near = new Map<PaneTemplateDef, string>();
  for (const template of registry.paneTemplates.values()) {
    const prefix = template.shortcut?.prefix;
    if (!prefix) continue;
    const code = [prefix, ...template.shortcut?.aliases ?? []].find((candidate) => {
      const known = normalizeLookupToken(candidate);
      return (!commandWord || known[0] === wanted[0]) && typoDistance(wanted, known) === 1;
    });
    if (code) near.set(template, code.toUpperCase());
  }
  if (near.size > NEAR_CODE_LIMIT) return [];
  return [...near].map(([template, code]) => ({ code, label: template.label }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function sampleArgForTemplate(template: PaneTemplateDef): string {
  switch (template.shortcut?.argKind) {
    case "ticker":
      return "AAPL";
    case "ticker-list":
      return "AAPL,MSFT";
    case "text":
      return "sample";
    default:
      return "";
  }
}

async function buildTemplateCatalogEntry(
  template: PaneTemplateDef,
  pane: PaneDef,
  context: MarketContext,
): Promise<PaneCatalogEntry> {
  const sampleArg = sampleArgForTemplate(template);
  const createOptions: PaneTemplateCreateOptions | undefined = buildCreateOptions(template, sampleArg);
  const primarySymbol = createOptions?.symbol ?? createOptions?.symbols?.[0] ?? null;
  let defaultSettings: Record<string, unknown> = {};

  if (template.createInstance) {
    try {
      const spec = await template.createInstance(buildTemplateContext(context, primarySymbol), createOptions);
      defaultSettings = spec?.settings ?? {};
    } catch {
      defaultSettings = {};
    }
  }

  const headless = getHeadlessPaneDefinition(template, pane);
  return {
    token: template.shortcut?.prefix ?? template.id,
    label: template.label,
    description: template.description,
    paneId: pane.id,
    paneName: pane.name,
    templateId: template.id,
    shortcut: template.shortcut?.prefix,
    aliases: [...(template.shortcut?.aliases ?? [])],
    argKind: headless?.argument.kind ?? template.shortcut?.argKind,
    argPlaceholder: headless?.argument.placeholder ?? template.shortcut?.argPlaceholder,
    keywords: template.keywords ?? [],
    defaultSettings,
    capability: getPaneFunctionCapability(template, pane),
  };
}

export async function buildPaneCatalogEntries(
  registry: PaneFunctionCatalog,
  context: MarketContext,
): Promise<PaneCatalogEntry[]> {
  const entries: PaneCatalogEntry[] = [];
  const templatedPaneIds = new Set<string>();

  for (const template of registry.paneTemplates.values()) {
    const pane = registry.panes.get(template.paneId);
    if (!pane) continue;
    templatedPaneIds.add(pane.id);
    entries.push(await buildTemplateCatalogEntry(template, pane, context));
  }

  for (const pane of registry.panes.values()) {
    if (templatedPaneIds.has(pane.id)) continue;
    const [shortcut, ...aliases] = builtInPanePrefixes(pane.id);
    entries.push({
      token: shortcut ?? pane.id,
      label: pane.name,
      description: `Open the ${pane.name} pane.`,
      paneId: pane.id,
      paneName: pane.name,
      shortcut,
      aliases,
      argKind: pane.headless?.argument.kind,
      argPlaceholder: pane.headless?.argument.placeholder,
      keywords: [],
      defaultSettings: {},
      capability: getPaneFunctionCapability(undefined, pane),
    });
  }

  return entries.sort((left, right) => left.token.localeCompare(right.token));
}

/** The phrase starting a word of the text, so "funding rate" finds "funding rates" but "rate" is not found in "separate". */
function containsPhrase(text: string, phrase: string): boolean {
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true;
  }
  return false;
}

// A multi-word query ranks a function carrying the whole phrase in its name or keywords first, then in its
// description, then one carrying every word in its name or description, then every word counting its flags;
// the rest rank by how many words they match.
const PHRASE_IN_NAME_BAND = 4000;
const PHRASE_IN_DESCRIPTION_BAND = 3000;
const ALL_WORDS_BAND = 2000;
const ALL_WORDS_WITH_FLAGS_BAND = 1000;
const PER_MATCHED_WORD = 100;
/** Loose matches (no function carries every word) listed before the rest are left to a refined query. */
const LOOSE_MATCH_LIMIT = 5;

function phraseBand(entry: PaneCatalogEntry, phrase: string): number {
  const lower = (values: Array<string | undefined>) => values
    .filter((value): value is string => !!value).map((value) => value.toLowerCase().replace(/\s+/g, " "));
  const names = lower([entry.token, entry.label, entry.paneName, entry.shortcut, ...entry.aliases, ...entry.keywords, ...entry.capability.aliases]);
  if (names.some((name) => containsPhrase(name, phrase))) return PHRASE_IN_NAME_BAND;
  const descriptions = lower([entry.description, ...entry.capability.intents]);
  return descriptions.some((description) => containsPhrase(description, phrase)) ? PHRASE_IN_DESCRIPTION_BAND : 0;
}

/** Words that join a topic without naming it: "year to date" is year and date. */
const QUERY_STOP_WORDS = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"]);

/** The words of a query that name something; a query of only joining words keeps them. */
function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  const named = words.filter((word) => !QUERY_STOP_WORDS.has(word));
  return named.length > 0 ? named : words;
}

/** What a function is called and says it does, apart from its flags. */
function nameAndDescription(entry: PaneCatalogEntry): string {
  return [
    entry.token,
    entry.label,
    entry.description,
    entry.paneId,
    entry.paneName,
    entry.templateId,
    entry.shortcut,
    ...entry.aliases,
    ...entry.keywords,
    ...entry.capability.aliases,
    ...entry.capability.intents,
  ].filter((value): value is string => !!value).join(" ").toLowerCase();
}

function flagText(entry: PaneCatalogEntry): string {
  return [
    entry.argKind,
    entry.argPlaceholder,
    entry.capability.outputKind,
    ...entry.capability.options.flatMap((option) => [
      option.description,
      ...(option.values ?? []).flatMap((value) => [value.value, ...(value.aliases ?? [])]),
    ]),
    ...Object.keys(entry.defaultSettings),
  ].filter((value): value is string => !!value).join(" ").toLowerCase();
}

interface CatalogMatchScore {
  score: number;
  /** The words of the query. */
  terms: number;
  /** Those found in the function's name, keywords or description. */
  named: number;
}

function scorePaneCatalogEntry(entry: PaneCatalogEntry, query: string): CatalogMatchScore {
  const terms = queryTerms(query);
  if (terms.length === 0) return { score: 1, terms: 0, named: 0 };
  const none = { score: 0, terms: terms.length, named: 0 };

  const exactTokens = [
    entry.token,
    entry.shortcut,
    ...entry.aliases,
    entry.templateId,
    entry.paneId,
  ].filter((value): value is string => !!value).map((value) => normalizeLookupToken(value));
  const flagKeys = entry.capability.options
    .flatMap((option) => [option.key, ...(option.aliases ?? [])]).map((value) => normalizeLookupToken(value));
  const named = nameAndDescription(entry);
  const flags = flagText(entry);
  const wholeQuery = query.toLowerCase().trim().replace(/\s+/g, " ");

  let score = containsPhrase(`${named} ${flags}`, wholeQuery) ? 12 : 0;
  // A query that is one of the function's own keywords ("hedge" for OSA) beats one found inside a
  // longer keyword ("hedge funds" for 13F).
  const keywords = [entry.label, ...entry.keywords, ...entry.capability.aliases]
    .filter((value): value is string => !!value).map((value) => value.toLowerCase().replace(/\s+/g, " "));
  if (keywords.includes(wholeQuery)) score += 4;
  let matchedTerms = 0;
  let matchedNamed = 0;
  let matchedFlagKeys = 0;
  for (const term of terms) {
    const normalized = normalizeLookupToken(term);
    // A term starts a word: "rate" is found in "rates" but not in "separate", nor "budget" in "budgetBps".
    if (exactTokens.includes(normalized)) {
      score += 8;
      matchedNamed += 1;
    } else if (containsPhrase(named, term)) {
      score += 2;
      matchedNamed += 1;
    } else if (normalized !== term && named.includes(normalized)) {
      score += 1;
      matchedNamed += 1;
    } else if (flagKeys.includes(normalized)) {
      score += 2;
      matchedFlagKeys += 1;
    } else if (containsPhrase(flags, term)) {
      score += 1;
    } else {
      continue;
    }
    matchedTerms += 1;
  }

  if (matchedTerms === 0) return none;
  // Words found only in a function's flags make a match when they are a flag's own name ("expiration") or,
  // together, cover the whole query ("funding rate" in two flags); one stray word in a flag's description
  // ("budget" in OSA's hedge budget) does not.
  if (matchedNamed === 0 && matchedFlagKeys === 0 && (terms.length === 1 || matchedTerms < terms.length)) return none;
  score += Math.round((matchedTerms / terms.length) * 8);
  if (entry.capability.botSafe) score += 2;
  // One word has no phrase to prefer: it keeps the plain term scores.
  if (terms.length === 1) return { score, terms: 1, named: matchedNamed };
  const allWords = matchedNamed === terms.length ? ALL_WORDS_BAND : matchedTerms === terms.length ? ALL_WORDS_WITH_FLAGS_BAND : 0;
  return {
    score: score + matchedTerms * PER_MATCHED_WORD + (phraseBand(entry, wholeQuery) || allWords),
    terms: terms.length,
    named: matchedNamed,
  };
}

function rankPaneCatalogEntries(entries: PaneCatalogEntry[], query: string): PaneCatalogEntry[] {
  return entries
    .map((entry) => ({ entry, score: scorePaneCatalogEntry(entry, query).score }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.token.localeCompare(right.entry.token))
    .map(({ entry }) => entry);
}

/** The shortest word start a fused query is cut into, and the shortest query that is cut. */
const FUSED_PART_MIN = 3;

/**
 * Two words typed as one ("volsurf" for Volatility Surface) match the functions that carry both
 * words, found by cutting the query into two word starts.
 */
function fusedQueryMatches(entries: PaneCatalogEntry[], query: string): PaneCatalogEntry[] {
  const word = query.trim().toLowerCase();
  if (/\s/.test(word)) return [];
  for (let cut = FUSED_PART_MIN; cut <= word.length - FUSED_PART_MIN; cut += 1) {
    const split = `${word.slice(0, cut)} ${word.slice(cut)}`;
    const ranked = rankPaneCatalogEntries(entries, split);
    const { shown, loose } = selectPaneCatalogMatches(ranked, split, ranked.length);
    if (shown.length > 0 && !loose) return shown;
  }
  return [];
}

export function filterPaneCatalogEntries(entries: PaneCatalogEntry[], query: string): PaneCatalogEntry[] {
  const ranked = rankPaneCatalogEntries(entries, query);
  return ranked.length > 0 ? ranked : fusedQueryMatches(entries, query);
}

interface PaneCatalogSelection {
  shown: PaneCatalogEntry[];
  /** Matches left out: the weaker ones, or those past the limit. */
  hidden: number;
  /** No function carries every word of the query; `shown` are the closest. */
  loose: boolean;
}

/**
 * The matches a search lists, best first. A multi-word query lists the functions that carry every word in their
 * name or description; when none does, the few closest, so "year to date" does not list a hundred functions
 * that each have a date somewhere. `--all` (an infinite limit) lists every match.
 */
export function selectPaneCatalogMatches(ranked: PaneCatalogEntry[], query: string, limit: number): PaneCatalogSelection {
  const scored = ranked.map((entry) => ({ entry, ...scorePaneCatalogEntry(entry, query) }));
  const every = (items: typeof scored) => items.map(({ entry }) => entry);
  const widened = !Number.isFinite(limit);
  const multiWord = (scored[0]?.terms ?? 0) > 1;
  if (widened || !multiWord) return { shown: every(scored).slice(0, limit), hidden: Math.max(0, ranked.length - limit), loose: false };

  const complete = scored.filter(({ terms, named }) => named === terms);
  if (complete.length > 0) {
    const shown = every(complete).slice(0, limit);
    return { shown, hidden: ranked.length - shown.length, loose: false };
  }
  const named = scored.filter(({ named }) => named > 0);
  const shown = every(named.length > 0 ? named : scored).slice(0, Math.min(limit, LOOSE_MATCH_LIMIT));
  return { shown, hidden: ranked.length - shown.length, loose: true };
}

/** Functions an unknown name is answered with. */
const SUGGESTION_LIMIT = 5;

/**
 * The functions closest to a name that opens none, as `catalog <name>` ranks them by name, keyword and
 * description. None when no function carries every word of it.
 */
export async function suggestPaneFunctions(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  name: string,
): Promise<PaneCatalogEntry[]> {
  const entries = await buildPaneCatalogEntries(registry, context);
  const { shown, loose } = selectPaneCatalogMatches(filterPaneCatalogEntries(entries, name), name, SUGGESTION_LIMIT);
  return loose ? [] : shown;
}

const CATALOG_TEXT_WIDTH = 100;
const READINESS_LABELS: Record<PaneFunctionReadiness, string> = {
  ready: "ready",
  partial: "partial",
  "live-dom": "rendered",
  unsupported: "none",
};

function readinessCell(readiness: PaneFunctionReadiness): string {
  const label = READINESS_LABELS[readiness];
  if (readiness === "ready") return cliStyles.success(label);
  if (readiness === "partial") return cliStyles.warning(label);
  return cliStyles.muted(label);
}

// Choices longer than this move from the flag into its description, where they can wrap.
const MAX_INLINE_CHOICES = 24;

function optionChoices(option: PaneFunctionOptionDef): string[] {
  return option.values?.map(({ value }) => String(value)) ?? [];
}

function optionFlags(option: PaneFunctionOptionDef): string {
  const choices = optionChoices(option).join("|");
  const value = choices && choices.length <= MAX_INLINE_CHOICES ? choices : option.values?.length ? "value" : option.placeholder ?? option.type;
  return `--${option.key} <${value}>`;
}

function optionDescription(option: PaneFunctionOptionDef): string {
  const choices = optionChoices(option);
  const parts = [option.description.replace(/\.$/, "")];
  if (choices.join("|").length > MAX_INLINE_CHOICES) parts.push(`One of ${choices.join(", ")}`);
  if (option.defaultValue !== undefined && option.defaultValue !== "") parts.push(`Default ${String(option.defaultValue)}`);
  return `${parts.join(". ")}.`;
}

/** A limitation as a sentence, so one does not run into the next: with a full stop unless it ends in one. */
export function limitationSentence(text: string): string {
  const trimmed = text.trim();
  return !trimmed || /[.!?]["')\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function renderCatalogEntry(entry: PaneCatalogEntry): string {
  const width = Math.min(cliTerminalWidth() ?? CATALOG_TEXT_WIDTH, CATALOG_TEXT_WIDTH);
  const capability = entry.capability;
  const argument = argumentHint(entry);
  const invocation = `${entry.token}${argument ? ` ${argument}` : ""}`;
  const lines = [
    `${cliStyles.accent(entry.token)}  ${cliStyles.bold(entry.label)}`,
    ...wrapText(entry.description, width),
    "",
  ];
  const stats: CliStatEntry[] = [
    ["Argument", argument || cliStyles.muted("none")],
    ["Report", readinessCell(capability.reportReadiness)],
    ["Screenshot", readinessCell(capability.screenshotReadiness)],
    ["Bot safe", capability.botSafe ? "yes" : "no"],
    ["Pane", entry.paneId],
  ];
  if (entry.aliases.length > 0) stats.push(["Aliases", entry.aliases.join(", ")]);
  const mnemonics = new Set([entry.token, ...entry.aliases].map((value) => value.toLowerCase()));
  const keywords = capability.aliases.filter((keyword) => !mnemonics.has(keyword.toLowerCase()));
  if (keywords.length > 0) stats.push(["Keywords", keywords.join(", ")]);
  if (capability.dataRequirements.length > 0) stats.push(["Requires", capability.dataRequirements.join(", ")]);
  if (capability.limitations.length > 0) stats.push(["Limitations", capability.limitations.map(limitationSentence).join(" ")]);
  lines.push(renderStats(stats));

  if (capability.options.length > 0) {
    lines.push("", renderSection("Options"));
    lines.push(...renderDefinitions(
      capability.options.map((option) => [optionFlags(option), optionDescription(option)] as const),
      { width, termStyle: cliStyles.command },
    ));
  }

  lines.push("", renderSection("Examples"));
  if (capability.reportReadiness !== "unsupported") {
    lines.push(...wrapCommandLine(`gloomberb fn ${invocation}`, width));
    for (const option of capability.options) {
      if (option.example) lines.push(...wrapCommandLine(`gloomberb fn ${invocation} ${option.example}`, width));
    }
  }
  lines.push(...wrapCommandLine(`gloomberb shot ${invocation} --output ${entry.token.toLowerCase()}.png`, width));
  return lines.join("\n");
}

/**
 * The glossary part of a search: the meaning of a term the query names, or
 * the terms that hold its words, to look up next.
 */
function renderCatalogGlossary(glossary: GlossaryLookup, width: number): string {
  const defined = glossary.exact.length > 0 ? [renderSection("Glossary"), ...renderGlossaryEntries(glossary.exact)] : [];
  const others = glossary.partial.map((entry) => entry.term).join(", ");
  const related = others
    ? wrapText(`${defined.length > 0 ? "Related" : "Glossary"}: ${others}. gloomberb catalog glossary <term> explains one.`, width)
      .map((line) => cliStyles.muted(line))
    : [];
  return [...defined, ...related].join("\n");
}

/** Series a catalog search lists before pointing at `shot CAT` for the rest. */
const CATALOG_SERIES_LIMIT = 8;

/**
 * `catalog [query]`: one function in full, or the matches, with the data
 * series and glossary terms the query names. `gap` is the line for data no
 * source carries yet (`knownGapMessage`): it leads, and stands in for "No
 * functions match".
 */
export function renderPaneCatalogReport(
  entries: PaneCatalogEntry[],
  args: ParsedPaneCatalogArgs,
  glossary: GlossaryLookup = { exact: [], partial: [] },
  gap: string | null = null,
  series: readonly SeriesMatch[] = [],
  /** The `config` command a query names a setting of ("light theme"), printed last, beside the functions. */
  setting: string | null = null,
): string {
  const query = args.query.trim().toLowerCase();
  const exact = query
    ? entries.find((entry) => entry.token.toLowerCase() === query)
      ?? entries.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === query))
    : undefined;
  const withSetting = (text: string) => [text, setting ?? ""].filter(Boolean).join("\n\n");
  if (exact) return withSetting(renderCatalogEntry(exact));

  const width = Math.min(cliTerminalWidth() ?? CATALOG_TEXT_WIDTH, CATALOG_TEXT_WIDTH);
  const terms = renderCatalogGlossary(glossary, width);
  const charted = renderSeriesMatches(args.query.trim(), series, Number.isFinite(args.limit) ? CATALOG_SERIES_LIMIT : series.length, width);
  const withGap = (text: string) => withSetting([gap ? wrapText(gap, width).join("\n") : "", text].filter(Boolean).join("\n\n"));
  const withTerms = (text: string) => withGap([text, charted, terms].filter(Boolean).join("\n\n"));
  if (args.query && entries.length === 1) return withTerms(renderCatalogEntry(entries[0]!));

  const note = (text: string) => wrapText(text, width).map((line) => cliStyles.muted(line)).join("\n");
  if (entries.length === 0) {
    if (charted) return withGap([charted, terms].filter(Boolean).join("\n\n"));
    if (glossary.exact.length > 0 || gap || setting) return withGap(terms);
    return withTerms(note(args.query
      ? `No functions match "${args.query}". Run gloomberb catalog to browse them all.`
      : "No functions are available."));
  }

  const { shown, hidden, loose } = selectPaneCatalogMatches(entries, args.query, args.limit);
  const count = hidden > 0 ? `${shown.length} of ${entries.length}` : String(entries.length);
  const title = args.query ? `Matches for "${args.query}"` : "Functions";
  const more = args.query
    ? `${hidden} more ${hidden === 1 ? "match" : "matches"}: refine the query, or add --all to list every match.`
    : `Add --all to list all ${entries.length}.`;
  const lines = [
    `${renderSection(title)} ${cliStyles.muted(`(${count})`)}`,
    renderTable(
      [
        { header: "Function", shrink: false },
        { header: "Name", maxWidth: 20 },
        { header: "Argument", maxWidth: 14 },
        { header: "Report" },
        { header: "Description" },
      ],
      shown.map((entry) => [
        cliStyles.command(entry.token),
        entry.label,
        argumentHint(entry),
        readinessCell(entry.capability.reportReadiness),
        entry.description,
      ]),
    ),
    "",
    note([
      loose ? "No function carries every word of the query; these are the closest." : "",
      "gloomberb catalog <function> shows its options and examples.",
      hidden > 0 ? more : "",
    ].filter(Boolean).join(" ")),
  ];
  return withTerms(lines.join("\n"));
}
