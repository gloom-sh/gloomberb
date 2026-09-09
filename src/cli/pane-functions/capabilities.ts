import type {
  HeadlessPaneArgumentDef,
  HeadlessPaneDefinition,
  HeadlessPaneOptionDef,
  HeadlessPaneOptionType,
  HeadlessPaneOptionValue,
  PaneDef,
  PaneTemplateDef,
} from "../../types/plugin";

export type PaneFunctionReadiness = "ready" | "partial" | "live-dom" | "unsupported";
export type PaneFunctionScreenshotReadiness = PaneFunctionReadiness;
export type PaneFunctionTickerCardinality = "none" | "one" | "one-or-more" | "two-or-more" | "one-or-two";
export type PaneFunctionOptionType = HeadlessPaneOptionType;
export type PaneFunctionOptionValue = HeadlessPaneOptionValue;
export type PaneFunctionOptionDef = HeadlessPaneOptionDef;
export type NormalizedPaneFunctionOptions = Record<string, string | number | boolean>;

export interface PaneFunctionCapability {
  id: string;
  botSafe: boolean;
  tickerCardinality: PaneFunctionTickerCardinality;
  aliases: string[];
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
    dataRequirements: [],
    limitations: [dataPane
      ? RENDERED_VIEW_LIMITATION
      : "This pane is an interactive surface and does not expose a data report."],
    options: [],
  };
}

export function isDataPaneForDomFallback(pane: Pick<PaneDef, "id">): boolean {
  return !NON_DATA_PANE_IDS.has(pane.id);
}

function optionToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_.-]+/g, "");
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

function resolveOptionDef(
  capability: PaneFunctionCapability,
  rawKey: string,
): PaneFunctionOptionDef | undefined {
  const token = optionToken(rawKey);
  return capability.options.find((option) => (
    optionToken(option.key) === token
    || option.aliases?.some((alias) => optionToken(alias) === token)
  ));
}

function normalizeEnumValue(option: PaneFunctionOptionDef, rawValue: string): string {
  const token = optionToken(rawValue);
  const match = option.values?.find((candidate) => (
    optionToken(candidate.value) === token
    || candidate.aliases?.some((alias) => optionToken(alias) === token)
  ));
  if (match) return match.value;
  throw new Error(
    `Invalid --${option.key} value "${rawValue}". Use one of: ${option.values?.map(({ value }) => value).join(", ") ?? ""}.`,
  );
}

function normalizeOptionValue(option: PaneFunctionOptionDef, rawValue: string | true): string | number | boolean {
  if (option.type === "boolean") {
    if (rawValue === true) return true;
    if (/^true$/i.test(rawValue)) return true;
    if (/^false$/i.test(rawValue)) return false;
    throw new Error(`Invalid --${option.key} value "${rawValue}". Use true or false.`);
  }
  if (rawValue === true) throw new Error(`--${option.key} requires a value.`);
  if (option.type === "enum") return normalizeEnumValue(option, rawValue);
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
  settings: { strict?: boolean } = {},
): NormalizedPaneFunctionOptions {
  if (!capability.botSafe) {
    return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, value]));
  }

  const normalized: Record<string, string | number | boolean> = {};
  for (const option of capability.options) {
    if (option.defaultValue !== undefined) normalized[option.key] = option.defaultValue;
  }
  for (const [rawKey, rawValue] of Object.entries(options)) {
    const option = resolveOptionDef(capability, rawKey);
    if (!option) {
      if (settings.strict === false) {
        normalized[rawKey] = rawValue;
        continue;
      }
      const supported = capability.options.map(({ key }) => `--${key}`).join(", ");
      throw new Error(
        `${capability.id} does not support --${rawKey}.${supported ? ` Supported options: ${supported}.` : " It has no options."}`,
      );
    }
    normalized[option.key] = normalizeOptionValue(option, rawValue);
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

export function capabilityOptionSummary(capability: PaneFunctionCapability): string[] {
  return capability.options.map((option) => {
    const values = option.values?.map(({ value }) => value).join("|");
    const defaultValue = option.defaultValue !== undefined ? ` default=${String(option.defaultValue)}` : "";
    return `--${option.key}${values ? ` <${values}>` : ` <${option.type}>`}${defaultValue}`;
  });
}
