import { logFailure } from "../../utils/log-failure";
import type { PaneInstanceConfig } from "../../types/config";
import { CHART_COMPOSER_PANE_ID } from "../../types/config";
import type {
  HeadlessPaneDefinition,
  PaneDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../types/plugin";
import { applyChartComposerCapabilityOptions } from "../../plugins/builtin/chart-composer/cli-options";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import { normalizeTickerInput } from "../../tickers/search";
import { slugifyName } from "../../utils/slugify";
import { ListingArgError, listingInstrument, listingReadNotes, resolveCliListing, usListingsOnlyMessage } from "../listing-arg";
import { uncoveredInstrumentKind, uncoveredInstrumentMessage } from "../../tickers/instrument-coverage";
import { uncoveredInstrumentCommand } from "../uncovered-instrument";
import { listingAbroadVenue } from "../../utils/sec";
import { splitSymbolArgs, stripStrayEdges } from "../symbol-args";
import { readNameEntries } from "../name-entries";
import { bankFigurePointer } from "../known-gaps";
import { readTerminalCodeArg } from "../../tickers/company-name-listing";
import type { MarketContext } from "../types";
import {
  buildPaneFunctionLookup,
  buildTemplateContext,
  findFunctionCode,
  nearFunctionCodes,
  suggestedFunctionCodes,
  suggestPaneFunctions,
  type NearFunctionCode,
  type PaneFunctionCatalog,
} from "./catalog";
import {
  argumentNamesTicker,
  buildCreateOptions,
  cleanTickerInput,
  normalizeLookupToken,
  optionSettings,
  parsePaneFunctionArgs,
  type ParsedPaneFunctionArgs,
} from "./options";
import { argumentSymbols, validateSymbolCount } from "./headless";
import {
  capabilityHasOption,
  capabilityPaneSettings,
  findCapabilityOption,
  getHeadlessPaneDefinition,
  getPaneFunctionCapability,
  noArgumentMessage,
  normalizeCapabilityOptions,
  paneFunctionArgument,
  takesNoArgument,
  type NormalizedPaneFunctionOptions,
  type PaneFunctionCapability,
} from "./capabilities";

export interface ResolvedPaneFunction {
  token: string;
  label: string;
  description: string;
  shortcut?: string;
  pane: PaneDef;
  template?: PaneTemplateDef;
  headless?: HeadlessPaneDefinition;
  instance: PaneInstanceConfig;
  createOptions: PaneTemplateCreateOptions | undefined;
  optionSettings: Record<string, unknown>;
  capability: PaneFunctionCapability;
  options: NormalizedPaneFunctionOptions;
  /** `--section` of a report: the table `--csv` and `--ndjson` write, when the function has no `section` option of its own. */
  tableSection?: string | true;
}

async function buildPaneInstance(
  resolved: Pick<ResolvedPaneFunction, "token" | "pane" | "template" | "headless" | "createOptions" | "optionSettings" | "capability" | "options">,
  context: MarketContext,
  target: string,
  command: "fn" | "shot",
): Promise<PaneInstanceConfig> {
  // Free text is a phrase, not a symbol. Treating it as a ticker makes the
  // pane look for a provider for values such as "HIGH GROWTH SOFTWARE".
  const headlessArgKind = resolved.headless?.argument.kind;
  const fallbackSymbol = !argumentNamesTicker(resolved.template, resolved.headless)
    ? null
    : headlessArgKind === "tickers" || headlessArgKind === "symbol-list"
      ? normalizeTickerInput(null, cleanTickerInput(target.split(/[,\s]+/)[0] ?? ""))
      : normalizeTickerInput(null, cleanTickerInput(target));
  const primarySymbol = resolved.createOptions?.symbol
    ?? resolved.createOptions?.symbols?.[0]
    ?? fallbackSymbol;
  const templateContext = buildTemplateContext(context, primarySymbol ?? null);
  const spec = await resolved.template?.createInstance?.(templateContext, resolved.createOptions) ?? {};
  const instanceId = `${resolved.pane.id}:cli-${slugifyName(target || resolved.pane.id, "pane")}`;
  const settings = (() => {
    if (resolved.pane.id !== CHART_COMPOSER_PANE_ID) {
      return { ...spec.settings, ...resolved.optionSettings };
    }
    const chartSpec = parseChartSpec(spec.settings?.chartSpec);
    if (!chartSpec) {
      // A chart of too few tickers (CMP of one) has none to draw: say how many it takes.
      if (resolved.headless) validateSymbolCount(resolved.headless, resolved.token, argumentSymbols(target), command);
      throw new Error("The chart template did not produce a valid chart specification.");
    }
    return {
      ...spec.settings,
      chartSpec: applyChartComposerCapabilityOptions(
        chartSpec,
        resolved.capability.id,
        resolved.options,
      ),
    };
  })();
  return {
    instanceId,
    paneId: resolved.pane.id,
    title: spec.title ?? primarySymbol ?? resolved.pane.name,
    binding: spec.binding ?? (primarySymbol ? { kind: "fixed", symbol: primarySymbol } : { kind: "none" }),
    params: spec.params,
    settings,
  };
}

/** The template or pane a name opens, as `fn` resolves it: a function code, an alias, a pane id or name, a keyword. */
export function findPaneFunction(registry: PaneFunctionCatalog, target: string): { template?: PaneTemplateDef; pane?: PaneDef } | null {
  const entry = buildPaneFunctionLookup(registry).get(normalizeLookupToken(target));
  if (!entry) return null;
  const template = "paneId" in entry && "description" in entry ? entry as PaneTemplateDef : undefined;
  return { template, pane: template ? registry.panes.get(template.paneId) : entry as PaneDef };
}

/**
 * `fn` and `shot` arguments read with the function's own options: one whose
 * value is a pair (MARS's `--fx-shift TRY -20`) takes the words after its
 * flag, which a function that has none would read as its argument.
 */
export function parsePaneFunctionArgsFor(
  registry: PaneFunctionCatalog,
  args: string[],
  globalOptions: { limit?: number; tail?: number } = {},
): ParsedPaneFunctionArgs {
  const parsed = parsePaneFunctionArgs(args, globalOptions);
  const found = parsed.target ? findPaneFunction(registry, parsed.target) : null;
  if (!found?.pane) return parsed;
  const capability = getPaneFunctionCapability(found.template, found.pane);
  if (!capability.options.some((option) => (option.valueWords ?? 1) > 1)) return parsed;
  return parsePaneFunctionArgs(args, globalOptions, (key) => findCapabilityOption(capability, key)?.valueWords ?? 1);
}

/**
 * `fn ANR SAN --exchange EPA` is `fn ANR SAN:EPA`: a function that takes
 * tickers gets each listing as `quote` reads it (`resolveCliListing`), so
 * `fn ERN 7203:TSE` is Toyota in Tokyo and an exchange the app does not know
 * fails with the venues the symbol trades on. With several symbols,
 * `--exchange` names the venue of the ones that name none. A function whose
 * data covers US listings only (`usListingsOnly`) answers a listing abroad
 * with that and the company's US listing, and leaves it out of a list.
 */
export async function applyListingArgument(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  args: ParsedPaneFunctionArgs,
  command: "fn" | "shot" = "fn",
): Promise<ParsedPaneFunctionArgs> {
  const found = args.target ? findPaneFunction(registry, args.target) : null;
  if (!found?.pane || !args.arg) return args;
  const headless = getHeadlessPaneDefinition(found.template, found.pane);
  const kind = headless?.argument.kind ?? found.template?.shortcut?.argKind;
  const takesOneTicker = kind === "ticker";
  const takesList = kind === "tickers" || kind === "symbol-list" || (!headless && kind === "ticker-list");
  // A function with an exchange option of its own (DIST) keeps it.
  // A ticker with spaces is no listing, unless it is a terminal's code for one ("JPM US Equity").
  if (!(takesOneTicker || takesList) || (takesOneTicker && /\s/.test(args.arg) && !await readTerminalCodeArg(context.dataProvider, args.arg))
    || getPaneFunctionCapability(found.template, found.pane).options.some((option) => option.key === "exchange")) {
    return args;
  }
  const exchange = typeof args.options.exchange === "string" ? args.options.exchange : undefined;
  const { exchange: _exchange, ...options } = args.options;
  // A list entry with spaces, or an argument of words, is a company's name search finds, or the symbols it holds.
  const typed = takesOneTicker ? [args.arg] : await readNameEntries(splitSymbolArgs([args.arg], { phrases: true }), context.dataProvider);
  if (typed.length === 0) return args;
  // RY.TO is the listing its quote names, RY:TSX, as `quote` reads it: a function's data is read by venue.
  let listings = await Promise.all(typed.map((raw) => resolveCliListing(raw, exchange, context, { ownExchangeWins: typed.length > 1, venueSuffix: true })));
  // A separator stuck to the end of a pasted list (`UPST;`) is not part of a symbol; it is named.
  const notes: string[] = takesOneTicker ? [] : stripStrayEdges(args.arg).notes;
  const token = found.template?.shortcut?.prefix ?? args.target.toUpperCase();
  // Words search finds no company for, and that are not symbols either, name nothing a function can read: tickers do.
  const unnamed = takesList ? listings.filter((listing) => /\s/.test(listing.symbol)) : [];
  if (unnamed.length > 0) {
    const names = unnamed.map((listing) => typed[listings.indexOf(listing)]!.trim());
    const answer = `No company found for ${names.map((name) => `"${name}"`).join(", ")}; type tickers`;
    const details = `Such as gloom ${command} ${token} GME,AMC. Find a company's ticker with gloom search "${names[0]!.replace(/"/g, "")}".`;
    listings = listings.filter((listing) => !unnamed.includes(listing));
    if (listings.length === 0) throw new ListingArgError(`${answer}.`, details);
    notes.push(`${answer}, such as GME,AMC.`);
  }
  // A function with company data answers an index or an ETF with what it is and where its data is, before
  // any request: its source would only say "Unknown ticker" or come back empty. A list leaves it out.
  const covered = found.pane.instruments;
  if (covered?.length) {
    const outside = (await Promise.all(listings.map(async (listing) => {
      const instrument = await listingInstrument(listing, context);
      return instrument && uncoveredInstrumentKind(covered, instrument.kind) ? { listing, instrument } : null;
    }))).filter((entry) => entry != null);
    if (outside.length > 0) {
      const answers = outside.map(({ instrument }) => ({
        message: uncoveredInstrumentMessage(token, covered, instrument),
        details: `Try: ${uncoveredInstrumentCommand(instrument)}`,
      }));
      listings = listings.filter((listing) => !outside.some((entry) => entry.listing === listing));
      if (listings.length === 0) {
        throw new ListingArgError(answers.map((answer) => answer.message).join("\n"), answers.map((answer) => answer.details).join("\n"));
      }
      notes.push(...answers.map((answer) => `${answer.message} ${answer.details}`));
    }
  }
  const usOnly = headless?.usListingsOnly;
  const abroad = usOnly ? listings.filter((listing) => listingAbroadVenue(listing.key) != null) : [];
  if (usOnly && abroad.length > 0) {
    const answers = await Promise.all(abroad.map(async (listing) => {
      const answer = await usListingsOnlyMessage(usOnly, listing, context, (key) => `gloom ${command} ${token} ${key}`);
      const hint = headless?.usListingsOnlyHint?.(listing.key);
      return hint ? { ...answer, details: `${answer.details}\n${hint}` } : answer;
    }));
    listings = listings.filter((listing) => !abroad.includes(listing));
    if (listings.length === 0) {
      throw new ListingArgError(answers.map((answer) => answer.message).join("\n"), answers.map((answer) => answer.details).join("\n"));
    }
    notes.push(...answers.map((answer) => `${answer.message} ${answer.details.replaceAll("\n", " ")}`));
  }
  // One listing's notes come with its choice note; a list's are said here.
  if (listings.length > 1) notes.unshift(...listings.flatMap(listingReadNotes));
  return {
    ...args,
    arg: listings.map((listing) => listing.key).join(", "),
    options,
    ...(listings.length === 1 ? { listing: listings[0]! } : {}),
    ...(notes.length > 0 ? { listingNotes: notes } : {}),
  };
}

/**
 * `--section` picks one table of a report's `--csv` or `--ndjson` output. A
 * function that has a `section` option of its own (CALLS: which part of a
 * transcript) keeps the flag; its report is one table, so there is nothing to
 * pick there.
 */
function takeTableSection(
  capability: PaneFunctionCapability,
  options: ParsedPaneFunctionArgs["options"],
): { options: ParsedPaneFunctionArgs["options"]; tableSection?: string | true } {
  if (!("section" in options) || capabilityHasOption(capability, "section")) return { options };
  const { section, ...rest } = options;
  return { options: rest, tableSection: section };
}

/** A name that opens no function: `details` list the closest ones and where to search for more. */
export class UnknownPaneFunctionError extends Error {
  constructor(name: string, readonly details: string, suggestion: string | null = null, message?: string) {
    super(message ?? `Unknown function or pane "${name}".${suggestion ? ` Did you mean ${suggestion}?` : ""}`);
    this.name = "UnknownPaneFunctionError";
  }
}

/** `RDCF (Reverse DCF)`, `ERN (Earnings) or EPS (EPS Estimates)`. */
function nearCodesText(near: readonly NearFunctionCode[]): string {
  const named = near.map(({ code, label }) => `${code} (${label})`);
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named.at(-1)}` : named[0]!;
}

/**
 * A name that opens no function: the code it is one slip from (`did you mean
 * RDCF?`) with the command that runs it on the same argument, the functions
 * the catalog finds for it, and where to search. A name near no code and
 * found by no search says so plainly and points at the whole catalog.
 */
async function unknownPaneFunctionError(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  name: string,
  arg: string,
  command: "fn" | "shot",
): Promise<UnknownPaneFunctionError> {
  // NIM is one slip from NI, but a bank figure is in `fundamentals`, not in a function's statement lines.
  const bank = bankFigurePointer(name, arg);
  if (bank) return new UnknownPaneFunctionError(name, bank.details, null, bank.message);
  // A word that asks for a function's data (IVOL for HIVG and OVDV) names them as a slip from a code names it.
  const suggested = suggestedFunctionCodes(registry, name);
  const near = [...suggested, ...nearFunctionCodes(registry, name).filter(({ code }) => !suggested.some((entry) => entry.code === code))];
  // A catalog that cannot be read still leaves the pointer to it.
  const closest = (await suggestPaneFunctions(registry, context, name).catch(logFailure("cli.pane-functions-resolver", "Find pane function suggestions failed", [])))
    .filter((entry) => !near.some(({ code }) => code === entry.token));
  const tokenWidth = Math.max(0, ...closest.map((entry) => entry.token.length));
  const word = /^[\w.:-]+$/.test(name) ? name : JSON.stringify(name);
  const argument = arg.trim() ? ` ${/^[\w.:,=%+@/$^-]+$/.test(arg.trim()) ? arg.trim() : JSON.stringify(arg.trim())}` : "";
  // One code is run on the argument; the functions a word asks for are each.
  const runs = suggested.length > 0 ? suggested : near.length === 1 ? near : [];
  return new UnknownPaneFunctionError(name, [
    // A function a word asks for, typed with no argument, shows the one it takes (`<ticker>`).
    ...runs.map(({ code }, index) => [index === 0 ? "Run:" : "    ", "gloom", command, code,
      argument.trim() || (suggested.length > 0 ? findFunctionCode(registry, code)?.argument : "")].filter(Boolean).join(" ")),
    ...closest.length > 0
      ? ["Closest matches:", ...closest.map((entry) => `  ${entry.token.padEnd(tokenWidth)}  ${entry.label}`), `Search the catalog: gloom catalog ${word}`]
      : near.length > 0 ? [] : [`No function code is close to ${word}. List every function: gloom catalog`],
  ].join("\n"), near.length > 0 ? nearCodesText(near) : null);
}

export async function resolvePaneFunction(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  parsedArgs: ParsedPaneFunctionArgs,
  resolutionSettings: { strictHeadlessOptions?: boolean; tableSection?: boolean; command?: "fn" | "shot" } = {},
): Promise<ResolvedPaneFunction> {
  let args = parsedArgs;
  if (!args.target) {
    throw new Error("Usage: gloom fn <function-or-pane> [argument] [--key value]");
  }

  const found = findPaneFunction(registry, args.target);
  if (!found) throw await unknownPaneFunctionError(registry, context, args.target, args.arg, resolutionSettings.command ?? "fn");

  const { template, pane } = found;
  if (!pane) {
    throw new Error(`Template "${template?.id}" points at missing pane "${template?.paneId}".`);
  }
  const createOptions = buildCreateOptions(template, args.arg);
  const headless = getHeadlessPaneDefinition(template, pane);
  const capability = getPaneFunctionCapability(template, pane);
  let tableSection: string | true | undefined;
  if (resolutionSettings.tableSection) {
    const taken = takeTableSection(capability, args.options);
    args = { ...args, options: taken.options };
    tableSection = taken.tableSection;
  }
  // What the user types for the function, which every error about it names.
  const token = template?.shortcut?.prefix ?? template?.id ?? pane.id;
  // A word after a function that takes none is most often one of its option values (`fn JODI gas`).
  // Every function the catalog lists with no argument refuses one, a rendered view (HALT) as a report (CBR).
  // The catalog lists templates and the panes no template opens (HELP); a pane opened by its id stands for its templates.
  const listed = template !== undefined || ![...registry.paneTemplates.values()].some((entry) => entry.paneId === pane.id);
  const refusesArgument = listed ? takesNoArgument(paneFunctionArgument(template, pane)) : headless?.argument.kind === "none";
  if (refusesArgument && args.arg?.trim()) {
    throw new Error(noArgumentMessage(capability.options, token, args.arg, resolutionSettings.command ?? "fn"));
  }
  const normalizedOptions = normalizeCapabilityOptions(capability, args.options, {
    strict: args.requireBotSafe || (!!headless && resolutionSettings.strictHeadlessOptions === true),
    code: token,
    argument: args.arg || null,
  });
  const settings = {
    ...optionSettings(args.options),
    ...capabilityPaneSettings(capability, normalizedOptions),
  };
  if (args.requireBotSafe) {
    validateTickerCardinality(capability, createOptions, token);
  }
  const resolved: ResolvedPaneFunction = {
    token,
    label: template?.label ?? pane.name,
    description: template?.description ?? `Open the ${pane.name} pane.`,
    shortcut: template?.shortcut?.prefix,
    pane,
    template,
    ...(headless ? { headless } : {}),
    instance: {} as PaneInstanceConfig,
    createOptions,
    optionSettings: settings,
    capability,
    options: normalizedOptions,
    ...(tableSection !== undefined ? { tableSection } : {}),
  };
  resolved.instance = await buildPaneInstance(resolved, context, args.arg, resolutionSettings.command ?? "fn");
  return resolved;
}

function validateTickerCardinality(
  capability: PaneFunctionCapability,
  createOptions: PaneTemplateCreateOptions | undefined,
  code: string,
): void {
  if (!capability.botSafe || capability.tickerCardinality === "none") return;
  const count = createOptions?.symbols?.length
    ?? (createOptions?.symbol ? 1 : 0);
  const valid = capability.tickerCardinality === "one"
    ? count === 1
    : capability.tickerCardinality === "one-or-more"
      ? count >= 1
      : capability.tickerCardinality === "two-or-more"
        ? count >= 2
        : count >= 1 && count <= 2;
  if (valid) return;

  const expectation = capability.tickerCardinality === "one"
    ? "exactly one ticker"
    : capability.tickerCardinality === "one-or-more"
      ? "at least one ticker"
      : capability.tickerCardinality === "two-or-more"
        ? "at least two tickers"
        : "one or two tickers";
  throw new Error(`${code} requires ${expectation}.`);
}
