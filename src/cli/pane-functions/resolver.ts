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
import { ListingArgError, listingReadNotes, resolveCliListing, usListingsOnlyMessage } from "../listing-arg";
import { listingAbroadVenue } from "../../utils/sec";
import type { MarketContext } from "../types";
import {
  buildPaneFunctionLookup,
  buildTemplateContext,
  suggestPaneFunctions,
  type PaneFunctionCatalog,
} from "./catalog";
import {
  buildCreateOptions,
  cleanTickerInput,
  normalizeLookupToken,
  optionSettings,
  type ParsedPaneFunctionArgs,
} from "./options";
import {
  capabilityHasOption,
  capabilityPaneSettings,
  getHeadlessPaneDefinition,
  getPaneFunctionCapability,
  normalizeCapabilityOptions,
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
  resolved: Pick<ResolvedPaneFunction, "pane" | "template" | "headless" | "createOptions" | "optionSettings" | "capability" | "options">,
  context: MarketContext,
  target: string,
): Promise<PaneInstanceConfig> {
  // Free text is a phrase, not a symbol. Treating it as a ticker makes the
  // pane look for a provider for values such as "HIGH GROWTH SOFTWARE".
  const shortcutArgKind = resolved.template?.shortcut?.argKind;
  const headlessArgKind = resolved.headless?.argument.kind;
  const fallbackSymbol = headlessArgKind === "free-text" || headlessArgKind === "none"
    ? null
    : headlessArgKind === "tickers" || headlessArgKind === "symbol-list"
      ? normalizeTickerInput(null, cleanTickerInput(target.split(/[,\s]+/)[0] ?? ""))
      : shortcutArgKind === "text"
        ? null
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
    if (!chartSpec) throw new Error("The chart template did not produce a valid chart specification.");
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

function findPaneFunction(registry: PaneFunctionCatalog, target: string): { template?: PaneTemplateDef; pane?: PaneDef } | null {
  const entry = buildPaneFunctionLookup(registry).get(normalizeLookupToken(target));
  if (!entry) return null;
  const template = "paneId" in entry && "description" in entry ? entry as PaneTemplateDef : undefined;
  return { template, pane: template ? registry.panes.get(template.paneId) : entry as PaneDef };
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
  if (!(takesOneTicker || takesList) || (takesOneTicker && /\s/.test(args.arg))
    || getPaneFunctionCapability(found.template, found.pane).options.some((option) => option.key === "exchange")) {
    return args;
  }
  const exchange = typeof args.options.exchange === "string" ? args.options.exchange : undefined;
  const { exchange: _exchange, ...options } = args.options;
  const typed = takesOneTicker ? [args.arg] : args.arg.split(/[,\s]+/).filter(Boolean);
  if (typed.length === 0) return args;
  let listings = await Promise.all(typed.map((raw) => resolveCliListing(raw, exchange, context, { ownExchangeWins: typed.length > 1 })));
  const notes: string[] = [];
  const usOnly = headless?.usListingsOnly;
  const abroad = usOnly ? listings.filter((listing) => listingAbroadVenue(listing.key) != null) : [];
  if (usOnly && abroad.length > 0) {
    const token = found.template?.shortcut?.prefix ?? args.target.toUpperCase();
    const answers = await Promise.all(abroad.map((listing) => usListingsOnlyMessage(
      usOnly, listing, context, (key) => `gloomberb ${command} ${token} ${key}`,
    )));
    listings = listings.filter((listing) => !abroad.includes(listing));
    if (listings.length === 0) {
      throw new ListingArgError(answers.map((answer) => answer.message).join("\n"), answers.map((answer) => answer.details).join("\n"));
    }
    notes.push(...answers.map((answer) => `${answer.message} ${answer.details}`));
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
  constructor(name: string, readonly details: string) {
    super(`Unknown function or pane "${name}".`);
    this.name = "UnknownPaneFunctionError";
  }
}

async function unknownPaneFunctionError(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  name: string,
): Promise<UnknownPaneFunctionError> {
  // A catalog that cannot be read still leaves the pointer to it.
  const closest = await suggestPaneFunctions(registry, context, name).catch(() => []);
  const tokenWidth = Math.max(0, ...closest.map((entry) => entry.token.length));
  const word = /^[\w.:-]+$/.test(name) ? name : JSON.stringify(name);
  return new UnknownPaneFunctionError(name, [
    ...closest.length > 0 ? ["Closest matches:", ...closest.map((entry) => `  ${entry.token.padEnd(tokenWidth)}  ${entry.label}`)] : [],
    `Search the catalog: gloomberb catalog ${word}`,
  ].join("\n"));
}

export async function resolvePaneFunction(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  parsedArgs: ParsedPaneFunctionArgs,
  resolutionSettings: { strictHeadlessOptions?: boolean; tableSection?: boolean } = {},
): Promise<ResolvedPaneFunction> {
  let args = parsedArgs;
  if (!args.target) {
    throw new Error("Usage: gloomberb fn <function-or-pane> [argument] [--key value]");
  }

  const found = findPaneFunction(registry, args.target);
  if (!found) throw await unknownPaneFunctionError(registry, context, args.target);

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
  resolved.instance = await buildPaneInstance(resolved, context, args.arg);
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
