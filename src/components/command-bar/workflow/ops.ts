import { type LayoutConfig, type PaneBinding, type PaneInstanceConfig } from "../../../types/config";
import type { PaneSettingField, PaneTemplateContext, PaneTemplateCreateOptions, PaneTemplateInstanceConfig, PaneTemplateDef } from "../../../types/plugin";
import { getFocusedCollectionId, getFocusedTickerSymbol } from "../../../state/app/context";
import type { PluginRegistry } from "../../../plugins/registry";
import { formatTickerListInput } from "../../../tickers/list";
import { updatePaneInstance, setPaneSettings } from "../../../pane-settings";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { cleanPortfolioPaneSettings, resolvePortfolioPaneCollectionId } from "../../../plugins/builtin/portfolio-list/settings";
import {
  DEFAULT_RELATIONSHIP_SECOND_SYMBOL,
  RELATIONSHIP_GRAPH_PANE_ID,
  buildRelationshipGraphPaneTitle,
} from "../../../plugins/builtin/correlation/relationship/model";
import { buildQuoteMonitorPaneTitle } from "../../../plugins/builtin/ticker-detail/settings";
import { getPaneTemplateDisplayLabel } from "../pane-templates/items";
import {
  resolveTickerInputOrThrow,
  resolveTickerListInput,
  type SharedWorkflowDeps,
} from "./tickers";

export {
  applyCollectionMembershipChange,
  getCollectionTargetOptions,
  resolvePreferredCollectionTarget,
  resolveSoleCollectionTarget,
  resolveTickerInput,
  resolveTickerInputOrThrow,
  resolveTickerListInput,
  type CollectionKind,
  type CollectionMembershipAction,
  type SharedWorkflowDeps,
} from "./tickers";

interface CreatePaneTemplateDeps extends SharedWorkflowDeps {
  buildPaneInstance: (
    paneType: string,
    options?: {
      title?: string;
      binding?: PaneBinding;
      params?: Record<string, string>;
      settings?: Record<string, unknown>;
      instanceId?: string;
    },
  ) => PaneInstanceConfig | null;
  placePaneInstance: (
    instance: PaneInstanceConfig,
    paneDef: NonNullable<ReturnType<PluginRegistry["panes"]["get"]>>,
    options?: PaneTemplateInstanceConfig,
  ) => void;
}

interface ApplyPaneSettingDeps extends SharedWorkflowDeps {
  persistLayout: (layout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
}

function updateTickerListPane(
  layout: LayoutConfig,
  targetId: string,
  options: {
    title: string;
    symbols: readonly string[];
    primarySymbol?: string;
    settings?: Record<string, unknown>;
  },
): LayoutConfig {
  const symbols = [...options.symbols];
  return updatePaneInstance(layout, targetId, (instance) => ({
    ...instance,
    title: options.title,
    ...(options.primarySymbol ? { binding: { kind: "fixed", symbol: options.primarySymbol } as PaneBinding } : {}),
    settings: {
      ...(instance.settings ?? {}),
      symbols,
      symbolsText: formatTickerListInput(symbols),
      ...(options.settings ?? {}),
    },
  }));
}

/** Key order in stored settings is not guaranteed, so compare on sorted keys. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right),
      ))
      : entry
  ));
}

/**
 * Find the pane a template would otherwise duplicate. A template that owns a
 * stable instance id (Chat keys one pane per channel) claims that instance even
 * after its settings drifted at runtime, as long as the id still belongs to the
 * same kind of pane; everything else has to match the whole create spec, so a
 * different ticker, collection or setting still opens its own pane.
 */
function findReusablePaneInstance(
  instances: PaneInstanceConfig[],
  paneId: string,
  spec: PaneTemplateInstanceConfig,
): PaneInstanceConfig | null {
  if (spec.instanceId) {
    const owner = instances.find((instance) => instance.instanceId === spec.instanceId);
    return owner?.paneId === paneId ? owner : null;
  }
  const specKey = stableKey([spec.binding ?? { kind: "none" }, spec.params ?? {}, spec.settings ?? {}]);
  return instances.find((instance) => (
    instance.paneId === paneId
    && stableKey([instance.binding ?? { kind: "none" }, instance.params ?? {}, instance.settings ?? {}]) === specKey
  )) ?? null;
}

/**
 * A stable-id pane outlives the spec that opened it (Chat rewrites its own
 * channelId as the user switches channels inside the pane), so reuse has to put
 * the pane back on the requested spec before focusing it, or the command lands
 * on a pane showing something else. Returns null when nothing has to change.
 */
function retargetPaneInstance(
  instance: PaneInstanceConfig,
  spec: PaneTemplateInstanceConfig,
): PaneInstanceConfig | null {
  const next: PaneInstanceConfig = {
    ...instance,
    title: spec.title ?? instance.title,
    binding: spec.binding ?? instance.binding,
    params: spec.params ? { ...(instance.params ?? {}), ...spec.params } : instance.params,
    settings: spec.settings ? { ...(instance.settings ?? {}), ...spec.settings } : instance.settings,
  };
  return stableKey(next) === stableKey(instance) ? null : next;
}

async function resolvePaneTemplateOptions(
  template: PaneTemplateDef,
  options: PaneTemplateCreateOptions | undefined,
  deps: SharedWorkflowDeps,
): Promise<{
  context: PaneTemplateContext;
  resolvedOptions: PaneTemplateCreateOptions | undefined;
}> {
  const state = deps.getState();
  const baseContext: PaneTemplateContext = {
    config: state.config,
    layout: state.config.layout,
    focusedPaneId: state.focusedPaneId,
    activeTicker: getFocusedTickerSymbol(state),
    activeCollectionId: getFocusedCollectionId(state),
  };

  let resolvedOptions = options;
  if (template.shortcut?.argPlaceholder === "ticker") {
    const resolvedTicker = await resolveTickerInputOrThrow(
      resolvedOptions?.symbol ?? resolvedOptions?.arg,
      baseContext.activeTicker,
      baseContext.activeCollectionId,
      deps,
    );
    resolvedOptions = {
      ...resolvedOptions,
      symbol: resolvedTicker.symbol,
      ticker: resolvedTicker.ticker,
      searchResult: null,
    };
  } else if (template.shortcut?.argPlaceholder === "tickers") {
    const rawInput = resolvedOptions?.arg ?? resolvedOptions?.values?.tickers ?? "";
    const symbols = await resolveTickerListInput(rawInput, baseContext.activeCollectionId, deps);
    resolvedOptions = {
      ...resolvedOptions,
      arg: rawInput,
      symbols,
    };
  }

  const context: PaneTemplateContext = {
    ...baseContext,
    activeTicker: resolvedOptions?.symbol ?? baseContext.activeTicker,
  };

  return {
    context,
    resolvedOptions,
  };
}

export async function createPaneTemplateOrThrow(
  templateId: string,
  options: PaneTemplateCreateOptions | undefined,
  deps: CreatePaneTemplateDeps,
): Promise<void> {
  const template = deps.pluginRegistry.paneTemplates.get(templateId);
  if (!template) {
    throw new Error(`Unknown pane template "${templateId}".`);
  }

  const state = deps.getState();
  const pluginId = deps.pluginRegistry.getPaneTemplatePluginId(templateId);
  if (pluginId && state.config.disabledPlugins.includes(pluginId)) {
    throw new Error("Enable this plugin before creating its pane.");
  }

  const { context, resolvedOptions } = await resolvePaneTemplateOptions(template, options, deps);

  if (template.canCreate && !template.canCreate(context, resolvedOptions)) {
    throw new Error(`Can't create ${getPaneTemplateDisplayLabel(template).toLowerCase()} right now.`);
  }

  const createInstanceResult = await template.createInstance?.(context, resolvedOptions);
  if (createInstanceResult === null) {
    return;
  }
  const spec = createInstanceResult ?? {};

  const paneDef = deps.pluginRegistry.panes.get(template.paneId);
  if (!paneDef) {
    throw new Error(`Unknown pane "${template.paneId}".`);
  }

  const instances = deps.getState().config.layout.instances;
  const existing = findReusablePaneInstance(instances, template.paneId, spec);
  if (existing) {
    const retargeted = retargetPaneInstance(existing, spec);
    if (retargeted) {
      deps.pluginRegistry.updateLayoutFn(updatePaneInstance(
        deps.getState().config.layout,
        existing.instanceId,
        () => retargeted,
      ));
    }
    deps.pluginRegistry.focusPaneFn(existing.instanceId);
    return;
  }

  const instance = deps.buildPaneInstance(template.paneId, {
    // A stable id another pane type already holds would collide, so the new pane picks its own.
    instanceId: instances.some((entry) => entry.instanceId === spec.instanceId) ? undefined : spec.instanceId,
    title: spec.title,
    binding: spec.binding,
    params: spec.params,
    settings: spec.settings,
  });
  if (!instance) {
    throw new Error("Open a matching ticker or collection context first.");
  }

  deps.placePaneInstance(instance, paneDef, spec);
}

export async function applyPaneSettingFieldValue(
  targetId: string,
  field: PaneSettingField,
  value: unknown,
  deps: ApplyPaneSettingDeps,
  options?: { pushHistory?: boolean },
): Promise<void> {
  if (field.type === "action") {
    throw new Error("Pane setting actions cannot be applied as values.");
  }
  const descriptor = deps.pluginRegistry.resolvePaneSettings(targetId);
  if (!descriptor) {
    throw new Error("This pane does not expose settings.");
  }

  const state = deps.getState();
  const shouldPushHistory = options?.pushHistory !== false;
  const clearOnChange = !Object.is(descriptor.context.settings[field.key], value)
    ? Object.fromEntries((field.clearOnChange ?? []).map((key) => [key, ""]))
    : {};

  if (field.storage === "plugin") {
    if (!descriptor.pluginId) {
      throw new Error("This pane setting is not owned by a plugin.");
    }
    await deps.pluginRegistry.setConfigStates(descriptor.pluginId, {
      ...clearOnChange,
      [field.key]: value,
    });
    return;
  }

  if (descriptor.pane.paneId === "quote-monitor" && (field.key === "symbol" || field.key === "symbolsText")) {
    const rawQuery = typeof value === "string" ? value.trim() : "";
    const symbols = await resolveTickerListInput(rawQuery, null, deps);
    const primarySymbol = symbols[0]!;
    const nextLayout = updateTickerListPane(state.config.layout, targetId, {
      title: buildQuoteMonitorPaneTitle(symbols),
      symbols,
      primarySymbol,
      settings: { symbol: primarySymbol },
    });
    deps.persistLayout(nextLayout, { pushHistory: shouldPushHistory });
    return;
  }

  if (descriptor.pane.paneId === RELATIONSHIP_GRAPH_PANE_ID && field.key === "symbolsText") {
    const rawInput = typeof value === "string" ? value : "";
    const symbols = await resolveTickerListInput(
      rawInput,
      descriptor.context.activeCollectionId,
      deps,
    );
    if (symbols.length > 2) {
      throw new Error("Enter one or two tickers.");
    }
    const pair: [string, string] = [symbols[0]!, symbols[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL];
    const nextLayout = updateTickerListPane(state.config.layout, targetId, {
      title: buildRelationshipGraphPaneTitle(pair),
      symbols: pair,
      primarySymbol: pair[0],
    });
    deps.persistLayout(nextLayout, { pushHistory: shouldPushHistory });
    return;
  }

  const currentSettings = {
    ...(descriptor.rawSettings ?? descriptor.context.settings),
    ...clearOnChange,
  };
  let nextSettings: Record<string, unknown> = descriptor.settingsDef.applyValue
    ? await descriptor.settingsDef.applyValue(
      currentSettings,
      field,
      value,
      descriptor.context,
    )
    : { ...currentSettings, [field.key]: value };

  if (descriptor.pane.paneId === "portfolio-list") {
    nextSettings = cleanPortfolioPaneSettings(nextSettings);
  }

  if (descriptor.pane.paneId === TICKER_RESEARCH_PANE_ID && field.key === "hideTabs" && value === true) {
    const lockedTabId = typeof descriptor.context.paneState.activeTabId === "string"
      ? descriptor.context.paneState.activeTabId
      : "overview";
    nextSettings.lockedTabId = lockedTabId;
  }

  let nextLayout = setPaneSettings(state.config.layout, targetId, nextSettings);

  if (descriptor.pane.paneId === "portfolio-list") {
    const currentCollectionId = typeof descriptor.context.paneState.collectionId === "string"
      ? descriptor.context.paneState.collectionId
      : (descriptor.context.activeCollectionId ?? "");
    const displayedCollectionId = resolvePortfolioPaneCollectionId(
      state.config,
      descriptor.context.settings,
      currentCollectionId,
    );
    const nextCollectionId = resolvePortfolioPaneCollectionId(
      state.config,
      nextSettings,
      displayedCollectionId || currentCollectionId,
    );
    if (nextCollectionId) {
      nextLayout = updatePaneInstance(nextLayout, targetId, (instance) => ({
        ...instance,
        params: {
          ...(instance.params ?? {}),
          collectionId: nextCollectionId,
        },
      }));
      deps.dispatch({ type: "UPDATE_PANE_STATE", paneId: targetId, patch: { collectionId: nextCollectionId } });
    }
  }

  deps.persistLayout(nextLayout, { pushHistory: shouldPushHistory });
}
