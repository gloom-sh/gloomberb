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
import type { MarketContext } from "../types";
import {
  buildPaneFunctionLookup,
  buildTemplateContext,
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
      ? normalizeTickerInput(null, cleanTickerInput(target.split(/[,\n]/)[0] ?? ""))
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

export async function resolvePaneFunction(
  registry: PaneFunctionCatalog,
  context: MarketContext,
  args: ParsedPaneFunctionArgs,
  resolutionSettings: { strictHeadlessOptions?: boolean } = {},
): Promise<ResolvedPaneFunction> {
  if (!args.target) {
    throw new Error("Usage: gloomberb fn <function-or-pane> [argument] [--key value]");
  }

  const lookup = buildPaneFunctionLookup(registry);
  const entry = lookup.get(normalizeLookupToken(args.target));
  if (!entry) {
    const shortcuts = [...registry.paneTemplates.values()]
      .map((template) => template.shortcut?.prefix)
      .filter((prefix): prefix is string => !!prefix)
      .sort();
    throw new Error(`Unknown function or pane "${args.target}". Try one of: ${shortcuts.slice(0, 18).join(", ")}`);
  }

  const template = "paneId" in entry && "description" in entry ? entry as PaneTemplateDef : undefined;
  const pane = template
    ? registry.panes.get(template.paneId)
    : entry as PaneDef;
  if (!pane) {
    throw new Error(`Template "${template?.id}" points at missing pane "${template?.paneId}".`);
  }
  const createOptions = buildCreateOptions(template, args.arg);
  const headless = getHeadlessPaneDefinition(template, pane);
  const capability = getPaneFunctionCapability(template, pane);
  const normalizedOptions = normalizeCapabilityOptions(capability, args.options, {
    strict: args.requireBotSafe || (!!headless && resolutionSettings.strictHeadlessOptions === true),
  });
  const settings = capability.botSafe
    ? {
      ...optionSettings(args.options),
      ...capabilityPaneSettings(capability, normalizedOptions),
    }
    : optionSettings(args.options);
  if (args.requireBotSafe) {
    validateTickerCardinality(capability, createOptions);
  }
  const resolved: ResolvedPaneFunction = {
    token: template?.shortcut?.prefix ?? template?.id ?? pane.id,
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
  };
  resolved.instance = await buildPaneInstance(resolved, context, args.arg);
  return resolved;
}

function validateTickerCardinality(
  capability: PaneFunctionCapability,
  createOptions: PaneTemplateCreateOptions | undefined,
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
  throw new Error(`${capability.id} requires ${expectation}.`);
}
