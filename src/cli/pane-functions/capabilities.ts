import type {
  HeadlessPaneArgumentDef,
  HeadlessPaneDefinition,
  HeadlessPaneOptionDef,
  PaneDef,
  PaneTemplateDef,
} from "../../types/plugin";

export type PaneFunctionReadiness = "ready" | "partial" | "live-dom" | "unsupported";
type PaneFunctionScreenshotReadiness = PaneFunctionReadiness;
type PaneFunctionTickerCardinality = "none" | "one" | "one-or-more" | "two-or-more" | "one-or-two";
/** A headless option, or a rendered view's, which may name its value, show an example and check what is typed. */
export type PaneFunctionOptionDef = HeadlessPaneOptionDef;
export type NormalizedPaneFunctionOptions = Record<string, string | number | boolean>;

export interface PaneFunctionCapability {
  id: string;
  botSafe: boolean;
  tickerCardinality: PaneFunctionTickerCardinality;
  aliases: string[];
  /** Words that are no code but ask for this function's data: `fn` and `catalog` answer them with it. */
  suggestFor?: string[];
  intents: string[];
  outputKind: string;
  reportReadiness: PaneFunctionReadiness;
  screenshotReadiness: PaneFunctionScreenshotReadiness;
  dataRequirements: string[];
  limitations: string[];
  options: PaneFunctionOptionDef[];
}

const NON_DATA_PANE_IDS = new Set([
  "account-management",
  "brokers",
  "changelog",
  "chat",
  "connections",
  "data-catalog",
  "debug",
  "help",
  "ibkr-trading",
  "layout-marketplace",
  "local-agent-workspace",
  "macro-tv",
  "plugin-marketplace",
  "world-venue-map",
]);

const RENDERED_VIEW_LIMITATION =
  "Reports contain only values exposed by the rendered view and may omit clipped or off-screen data.";

function fallbackCapability(
  template: PaneTemplateDef | undefined,
  pane: PaneDef,
): PaneFunctionCapability {
  const dataPane = isDataPaneForDomFallback(pane);
  return {
    id: template?.id ?? pane.id,
    botSafe: false,
    tickerCardinality: "none",
    aliases: [],
    intents: [],
    outputKind: dataPane ? "rendered-view" : "pane",
    reportReadiness: dataPane ? "live-dom" : "unsupported",
    screenshotReadiness: "live-dom",
    dataRequirements: [...(pane.reportRequirements ?? [])],
    limitations: [dataPane
      ? RENDERED_VIEW_LIMITATION
      : "This pane is an interactive surface and does not expose a data report."],
    options: [...(pane.reportOptions ?? [])],
  };
}

export function isDataPaneForDomFallback(pane: Pick<PaneDef, "id">): boolean {
  return !NON_DATA_PANE_IDS.has(pane.id);
}

function optionToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.-]+/g, "");
}

// Choices longer than this move from the flag into its description, where they can wrap.
export const MAX_INLINE_CHOICES = 24;

export function optionChoices(option: PaneFunctionOptionDef): string[] {
  return option.values?.map(({ value }) => String(value)) ?? [];
}

/** `--commodity <oil|gas>`: an option as the catalog and errors write it, its choices inline when they are short. */
export function optionFlags(option: PaneFunctionOptionDef): string {
  const choices = optionChoices(option).join("|");
  const value = choices && choices.length <= MAX_INLINE_CHOICES ? choices : option.values?.length ? "value" : option.placeholder ?? option.type;
  return `--${option.key} <${value}>`;
}

/** The option values a typed word is, by value or alias: `gas` is JODI's `--commodity gas`. */
function optionValueOf(options: readonly PaneFunctionOptionDef[], typed: string): string | null {
  const token = optionToken(typed);
  for (const option of options) {
    const value = option.values?.find((candidate) => optionToken(candidate.value) === token
      || candidate.aliases?.some((alias) => optionToken(alias) === token));
    if (value) return `--${option.key} ${value.value}`;
  }
  return null;
}

/** Options that name an underlying listing, which a ticker typed after the function is meant for. */
const LISTING_OPTION_KEYS = new Set(["symbol", "ticker", "underlying"]);

/** `--symbol NEM` for a word that reads as a ticker (NEM, BHP:ASX, 7203.T), when the function takes one as an option. */
function listingOptionOf(options: readonly PaneFunctionOptionDef[], typed: string): string | null {
  const word = typed.trim();
  if (!/^[A-Za-z0-9^][A-Za-z0-9.:=^&-]{0,23}$/.test(word) || !/[A-Za-z]/.test(word)) return null;
  const option = options.find(({ key, type }) => type === "string" && LISTING_OPTION_KEYS.has(optionToken(key)));
  return option ? `--${option.key} ${word}` : null;
}

/** An option in use, as typed after the function: its own example, else a choice that is not the default. */
function optionExample(option: PaneFunctionOptionDef): string {
  if (option.example) return option.example;
  if (option.type === "boolean") return `--${option.key}`;
  const choice = option.values?.find(({ value }) => value !== option.defaultValue);
  if (choice) return `--${option.key} ${choice.value}`;
  return `--${option.key} <${option.placeholder ?? option.type}>`;
}

/** Options a no-argument error lists before it points at the catalog for the rest. */
const LISTED_OPTIONS = 6;

/**
 * What a function that takes no argument answers one with: its options and a
 * command to run. A word that is one of an option's values runs as that option
 * (`fn JODI gas` is `fn JODI --commodity gas`), and a ticker runs as the option that takes one
 * (`fn OVME NEM` is `fn OVME --symbol NEM`); anything else gets an option's example.
 */
export function noArgumentMessage(
  options: readonly PaneFunctionOptionDef[],
  code: string,
  typed: string,
  command: "fn" | "shot" = "fn",
): string {
  const head = `${code} does not accept an argument.`;
  if (options.length === 0) return `${head} Run: gloomberb ${command} ${code}`;
  const asOption = optionValueOf(options, typed) ?? listingOptionOf(options, typed);
  const listed = options.slice(0, LISTED_OPTIONS).map(optionFlags).join(", ");
  const more = options.length > LISTED_OPTIONS ? ` and ${options.length - LISTED_OPTIONS} more (gloomberb catalog ${code})` : "";
  const run = asOption ? `Run: gloomberb ${command} ${code} ${asOption}` : `Example: gloomberb ${command} ${code} ${optionExample(options[0]!)}`;
  return `${head} Options: ${listed}${more}. ${run}`;
}

function headlessTickerCardinality(argument: HeadlessPaneArgumentDef): PaneFunctionTickerCardinality {
  switch (argument.kind) {
    case "ticker":
      return "one";
    case "tickers":
    case "symbol-list":
      return argument.maximum === 2 && (argument.minimum ?? 1) === 1
        ? "one-or-two"
        : (argument.minimum ?? 1) >= 2 ? "two-or-more" : "one-or-more";
    case "none":
    case "free-text":
      return "none";
    default: {
      const _exhaustive: never = argument.kind;
      return _exhaustive;
    }
  }
}

export function getHeadlessPaneDefinition(
  template: PaneTemplateDef | undefined,
  pane: PaneDef,
): HeadlessPaneDefinition | undefined {
  return template?.headless ?? pane.headless;
}

export function getPaneFunctionCapability(
  template: PaneTemplateDef | undefined,
  pane: PaneDef,
): PaneFunctionCapability {
  const fallback = fallbackCapability(template, pane);
  const headless = getHeadlessPaneDefinition(template, pane);
  if (!headless) return fallback;
  return {
    ...fallback,
    aliases: template?.keywords ?? [],
    intents: template ? [template.description] : [],
    limitations: [],
    ...headless.discovery,
    botSafe: true,
    tickerCardinality: headlessTickerCardinality(headless.argument),
    outputKind: headless.shape,
    reportReadiness: "ready",
    options: [...headless.options],
  };
}

/** The option a key names, by its own name or an alias, in any spelling (`min-pct`, `minPct`). */
export function findCapabilityOption(
  capability: PaneFunctionCapability,
  rawKey: string,
): PaneFunctionOptionDef | undefined {
  const token = optionToken(rawKey);
  return capability.options.find((option) => (
    optionToken(option.key) === token
    || option.aliases?.some((alias) => optionToken(alias) === token)
  ));
}

/** Whether the function has an option of its own under this name or an alias. */
export function capabilityHasOption(capability: PaneFunctionCapability, key: string): boolean {
  return findCapabilityOption(capability, key) !== undefined;
}

function normalizeEnumValue(option: PaneFunctionOptionDef, rawValue: string, argument: string | null): string {
  const token = optionToken(rawValue);
  const match = option.values?.find((candidate) => (
    optionToken(candidate.value) === token
    || candidate.aliases?.some((alias) => optionToken(alias) === token)
  ));
  if (match) return match.value;
  const hint = option.invalidValueHint?.(rawValue, argument);
  throw new Error(
    `Invalid --${option.key} value "${rawValue}".${hint ? ` ${hint}` : ""} Use one of: ${option.values?.map(({ value }) => value).join(", ") ?? ""}.`,
  );
}

function normalizeOptionValue(
  option: PaneFunctionOptionDef,
  rawValue: string | true,
  argument: string | null = null,
): string | number | boolean {
  if (option.type === "boolean") {
    if (rawValue === true) return true;
    if (/^true$/i.test(rawValue)) return true;
    if (/^false$/i.test(rawValue)) return false;
    throw new Error(`Invalid --${option.key} value "${rawValue}". Use true or false.`);
  }
  if (rawValue === true) throw new Error(`--${option.key} requires a value.`);
  if (option.normalize) return option.normalize(rawValue);
  if (option.type === "enum") return normalizeEnumValue(option, rawValue, argument);
  if (option.type === "integer") {
    const value = Number(rawValue);
    if (!Number.isInteger(value)) throw new Error(`--${option.key} must be an integer.`);
    if (option.minimum != null && value < option.minimum) {
      throw new Error(`--${option.key} must be at least ${option.minimum}.`);
    }
    if (option.maximum != null && value > option.maximum) {
      throw new Error(`--${option.key} must be at most ${option.maximum}.`);
    }
    return value;
  }
  return rawValue;
}

export function normalizeCapabilityOptions(
  capability: PaneFunctionCapability,
  options: Record<string, string | true>,
  /**
   * `code` is what the user types for the function (`CDX`), which an error names; the capability id stands in when
   * there is none. `argument` is what the function was given (`RMS.AX`), which an option's pointer names.
   */
  settings: { strict?: boolean; code?: string; argument?: string | null } = {},
): NormalizedPaneFunctionOptions {
  if (!capability.botSafe) {
    // A rendered view takes any pane setting; the options it declares are checked.
    return Object.fromEntries(Object.entries(options).map(([key, value]) => {
      const option = findCapabilityOption(capability, key);
      return option ? [option.key, normalizeOptionValue(option, value, settings.argument)] : [key, value];
    }));
  }

  const normalized: Record<string, string | number | boolean> = {};
  for (const option of capability.options) {
    if (option.defaultValue !== undefined) normalized[option.key] = option.defaultValue;
  }
  for (const [rawKey, rawValue] of Object.entries(options)) {
    const option = findCapabilityOption(capability, rawKey);
    if (!option) {
      if (settings.strict === false) {
        normalized[rawKey] = rawValue;
        continue;
      }
      const supported = capability.options.map(({ key }) => `--${key}`).join(", ");
      throw new Error(
        `${settings.code ?? capability.id} does not support --${rawKey}.${supported ? ` Supported options: ${supported}.` : " It has no options."}`,
      );
    }
    normalized[option.key] = normalizeOptionValue(option, rawValue, settings.argument);
  }
  return normalized;
}

export function capabilityPaneSettings(
  capability: PaneFunctionCapability,
  options: NormalizedPaneFunctionOptions,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const option of capability.options) {
    if (option.pluginState) continue;
    const value = options[option.key];
    if (value !== undefined) settings[option.settingKey ?? option.key] = value;
  }
  return settings;
}

export function capabilityPluginState(
  capability: PaneFunctionCapability,
  options: NormalizedPaneFunctionOptions,
): Record<string, Record<string, unknown>> {
  const pluginState: Record<string, Record<string, unknown>> = {};
  for (const option of capability.options) {
    if (!option.pluginState) continue;
    const value = options[option.key];
    if (value === undefined) continue;
    const plugin = pluginState[option.pluginState.pluginId] ?? {};
    plugin[option.pluginState.key ?? option.key] = value;
    pluginState[option.pluginState.pluginId] = plugin;
  }
  return pluginState;
}
