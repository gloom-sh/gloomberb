import { type LayoutConfig, type PaneBinding, type PaneInstanceConfig } from "../../../types/config";
import type { PaneSettingField, PaneTemplateContext, PaneTemplateCreateOptions, PaneTemplateInstanceConfig, PaneTemplateDef } from "../../../types/plugin";
import { getFocusedCollectionId, getFocusedTickerSymbol } from "../../../state/app/context";
import { resolveInstrumentForPane, resolveListingForPane } from "../../../core/state/app/instrument";
import { resolveTickerOpenTarget, tickerOpenFailureMessage } from "../../../tickers/open-target";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { scopedBrokerContractIdentityKey } from "../../../utils/instrument-identity";
import { tickerSelectionFromSearchResult } from "../../../tickers/selection";
import { tickerInstrumentLabel } from "../../../tickers/instrument-label";
import type { PluginRegistry } from "../../../plugins/registry";
import { PluginOffError } from "../../../plugins/plugin-off";
import { formatTickerListInput } from "../../../tickers/list";
import { PANE_LOCK_SETTING_KEY, setPaneLocked, updatePaneInstance, setPaneSettings } from "../../../pane-settings";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { cleanPortfolioPaneSettings, resolvePortfolioPaneCollectionId } from "../../../plugins/builtin/portfolio-list/settings";
import {
  DEFAULT_RELATIONSHIP_SECOND_SYMBOL,
  RELATIONSHIP_GRAPH_PANE_ID,
  buildRelationshipGraphPaneTitle,
} from "../../../plugins/builtin/correlation/relationship/model";
import { buildQuoteMonitorPaneTitle } from "../../../plugins/builtin/ticker-detail/settings";
import { getPaneTemplateDisplayLabel } from "../pane-templates/items";
import { automationActive, describeUsageFunction, recordFunctionOpen } from "../../../telemetry/usage-counts";
import { attentionActionForPane, captureAttentionAction } from "../../../telemetry/attention-counts";
import { publicTickerKey } from "../../../utils/exchanges";
import { keysClearedByChange } from "./fields";
import { findReusablePaneInstance, retargetPaneInstance, withFreeTickerInstanceId } from "./pane-reuse";
import {
  resolveTickerInputOrThrow,
  resolveTickerListInput,
  type SharedWorkflowDeps,
  type ResolvedTickerInput,
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
    activeInstrument: state.focusedPaneId ? resolveInstrumentForPane(state, state.focusedPaneId)?.instrument : undefined,
    activeListing: state.focusedPaneId ? resolveListingForPane(state, state.focusedPaneId) : undefined,
    activeCollectionId: getFocusedCollectionId(state),
  };

  let resolvedOptions = options;
  // Templates whose ticker is optional (JOBS, CALLS, CDS) open market-wide when
  // nothing was named, so they must not resolve a ticker at all: there is no
  // input to match, and silently falling back to the active ticker would bind a
  // pane the caller deliberately left unbound.
  // INS opens its own view without one (the market's insider buying) when
  // nothing is named and no ticker is active; with one active it opens on it.
  const tickerNamed = !!(resolvedOptions?.symbol?.trim() || resolvedOptions?.arg?.trim() || resolvedOptions?.ticker);
  const opensWithoutTicker = !!template.shortcut?.argOptional || (!!template.shortcut?.openWithoutArg && !baseContext.activeTicker);
  const resolvesTicker = template.shortcut?.argPlaceholder === "ticker" && (tickerNamed || !opensWithoutTicker);
  if (resolvesTicker) {
    if (resolvedOptions?.instrument === null && !resolvedOptions.ticker) {
      const publicQuery = resolvedOptions.symbol ?? resolvedOptions.arg ?? baseContext.activeTicker ?? "";
      const publicTarget = await resolveTickerOpenTarget({ query: publicQuery,
        tickers: state.tickers, tickerRepository: deps.tickerRepository, dataProvider: deps.dataProvider, publicOnly: true });
      if (!publicTarget) throw new Error(tickerOpenFailureMessage(publicQuery.trim().toUpperCase()));
      deps.dispatch({ type: "UPDATE_TICKER", ticker: publicTarget.ticker });
      if (publicTarget.created) deps.pluginRegistry.events.emit("ticker:added", { symbol: publicTarget.symbol, ticker: publicTarget.ticker });
      resolvedOptions = { ...resolvedOptions, symbol: publicTarget.symbol, ticker: publicTarget.ticker, listing: resolvedOptions.listing ?? publicTarget.listing };
    }
    const requested = resolvedOptions?.symbol ?? resolvedOptions?.arg;
    const activeTicker = baseContext.activeTicker && baseContext.activeInstrument !== undefined
      && (!requested || requested === baseContext.activeTicker) ? state.tickers.get(baseContext.activeTicker) : undefined;
    const resolvedTicker: Pick<ResolvedTickerInput, "symbol" | "ticker" | "instrument" | "listing"> = resolvedOptions?.ticker && resolvedOptions.ticker.metadata.ticker === resolvedOptions.symbol
      ? { symbol: resolvedOptions.symbol, ticker: resolvedOptions.ticker }
      : activeTicker ? { symbol: activeTicker.metadata.ticker, ticker: activeTicker }
      : await resolveTickerInputOrThrow(
      resolvedOptions?.symbol ?? resolvedOptions?.arg,
      baseContext.activeTicker,
      baseContext.activeCollectionId,
      deps,
      { preserveListingKey: true },
    );
    resolvedOptions = {
      ...resolvedOptions,
      symbol: resolvedTicker.symbol,
      ticker: resolvedTicker.ticker,
      searchResult: null,
      instrument: resolvedOptions?.instrument !== undefined ? resolvedOptions.instrument
        : resolvedOptions?.searchResult ? tickerSelectionFromSearchResult(resolvedOptions.searchResult).instrument
        : resolvedTicker.instrument !== undefined ? resolvedTicker.instrument
        : resolvedTicker.symbol === baseContext.activeTicker && baseContext.activeInstrument !== undefined ? baseContext.activeInstrument
        : instrumentFromTicker(resolvedTicker.ticker)?.instrument,
      listing: resolvedOptions?.listing ?? tickerSelectionFromSearchResult(resolvedOptions?.searchResult ?? undefined).listing
        ?? resolvedTicker.listing
        ?? (resolvedTicker.symbol === baseContext.activeTicker ? baseContext.activeListing : undefined),
    };
  } else if (template.shortcut?.argPlaceholder === "tickers") {
    const rawInput = resolvedOptions?.arg ?? resolvedOptions?.values?.tickers ?? "";
    const symbols = !String(rawInput).trim() && template.shortcut?.openWithoutArg
      ? []
      : await resolveTickerListInput(rawInput, baseContext.activeCollectionId, deps, template.shortcut?.keepArgToken);
    resolvedOptions = {
      ...resolvedOptions,
      arg: rawInput,
      symbols,
    };
  }

  const context: PaneTemplateContext = {
    ...baseContext,
    activeTicker: resolvedOptions?.symbol ?? baseContext.activeTicker,
    activeInstrument: resolvedOptions?.instrument !== undefined ? resolvedOptions.instrument
      : !resolvedOptions?.symbol || resolvedOptions.symbol === baseContext.activeTicker ? baseContext.activeInstrument : undefined,
    activeListing: resolvedOptions?.listing
      ?? (!resolvedOptions?.symbol || resolvedOptions.symbol === baseContext.activeTicker ? baseContext.activeListing : undefined),
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
  // Read before the first await: automation that started this open may have
  // finished by the time the pane is placed.
  const openedByUser = !automationActive();
  const recordAttention = captureAttentionAction();

  const state = deps.getState();
  const pluginId = deps.pluginRegistry.getPaneTemplatePluginId(templateId);
  // The template's plugin, or the plugin of the pane it opens (CHOKE opens a
  // chart): a pane of a switched-off plugin would be added hidden.
  const disabledOwner = deps.pluginRegistry.getDisabledPaneTemplateOwner(templateId, state.config.disabledPlugins);
  if (disabledOwner) throw new PluginOffError(disabledOwner, getPaneTemplateDisplayLabel(template));

  const { context, resolvedOptions } = await resolvePaneTemplateOptions(template, options, deps);

  if (template.canCreate && !template.canCreate(context, resolvedOptions)) {
    throw new Error(`Can't create ${getPaneTemplateDisplayLabel(template).toLowerCase()} right now.`);
  }

  const createInstanceResult = await template.createInstance?.(context, resolvedOptions);
  if (createInstanceResult === null) {
    return;
  }
  let spec = createInstanceResult ?? {};
  if (spec.binding?.kind === "fixed" && spec.binding.symbol === context.activeTicker && context.activeInstrument !== undefined) {
    const instrument = spec.binding.instrument !== undefined ? spec.binding.instrument : context.activeInstrument;
    const listing = spec.binding.listing ?? context.activeListing;
    const label = tickerInstrumentLabel(spec.binding.symbol, instrument);
    spec = { ...spec, binding: { ...spec.binding, instrument, ...(listing ? { listing } : {}) },
      ...(spec.instanceId && instrument ? { instanceId: `${spec.instanceId}:${encodeURIComponent(scopedBrokerContractIdentityKey(instrument))}` } : {}),
      ...(spec.title?.endsWith(spec.binding.symbol) ? { title: spec.title.slice(0, -spec.binding.symbol.length) + label } : {}),
    };
  }

  const paneDef = deps.pluginRegistry.panes.get(template.paneId);
  if (!paneDef) {
    throw new Error(`Unknown pane "${template.paneId}".`);
  }
  const countAttention = () => {
    const action = attentionActionForPane(template.paneId);
    if (!action || !openedByUser) return;
    const primary = spec.binding?.kind === "fixed" ? spec.binding.symbol : null;
    const symbols = template.paneId === "quote-monitor" && Array.isArray(spec.settings?.symbols)
      ? spec.settings.symbols.filter((value): value is string => typeof value === "string")
      : primary ? [primary] : [];
    for (const symbol of symbols) {
      const exchange = symbol === primary && spec.binding?.kind === "fixed"
        ? spec.binding.listing?.exchange ?? deps.getState().tickers.get(symbol)?.metadata.exchange
        : deps.getState().tickers.get(symbol)?.metadata.exchange;
      recordAttention(publicTickerKey(symbol, exchange), action);
    }
  };

  const instances = deps.getState().config.layout.instances;
  spec = withFreeTickerInstanceId(instances, template.paneId, spec);
  const existing = findReusablePaneInstance(
    instances,
    template,
    deps.pluginRegistry.paneTemplates,
    spec,
    { focusedPaneId: deps.getState().focusedPaneId, paneDef: deps.pluginRegistry.panes.get(template.paneId) },
  );
  if (existing) {
    const retargeted = retargetPaneInstance(existing, spec);
    const nextLayout = retargeted ? updatePaneInstance(
        deps.getState().config.layout,
        existing.instanceId,
        () => retargeted,
      ) : undefined;
    if (nextLayout) deps.pluginRegistry.updateLayout(nextLayout);
    // React can batch the layout update and focus. Bringing a floating pane to
    // the front must use its retargeted settings, not the preceding render.
    deps.pluginRegistry.focusPane(existing.instanceId, nextLayout);
    if (openedByUser) countTemplateOpen(template, pluginId, deps);
    countAttention();
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
  if (openedByUser) countTemplateOpen(template, pluginId, deps);
  countAttention();
}

/** Every pane template the user opens, from the command bar, a menu or another pane, passes here. */
function countTemplateOpen(template: PaneTemplateDef, pluginId: string | undefined, deps: CreatePaneTemplateDeps): void {
  recordFunctionOpen(describeUsageFunction(deps.pluginRegistry, pluginId, template.shortcut?.prefix));
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

  // The lock lives on the pane instance, not in pane settings, so it never
  // reaches a plugin's `applyValue`.
  if (field.key === PANE_LOCK_SETTING_KEY) {
    deps.persistLayout(
      setPaneLocked(state.config.layout, targetId, value === true),
      { pushHistory: shouldPushHistory },
    );
    return;
  }

  const clearOnChange = Object.fromEntries(
    keysClearedByChange(field.clearOnChange, descriptor.context.settings[field.key], value).map((key) => [key, ""]),
  );

  if (field.storage === "plugin") {
    if (!descriptor.pluginId) {
      throw new Error("This pane setting is not owned by a plugin.");
    }
    const previous = field.store
      ? deps.pluginRegistry.getConfigState(descriptor.pluginId, field.key)
      : undefined;
    await deps.pluginRegistry.setConfigStates(descriptor.pluginId, {
      ...clearOnChange,
      [field.key]: field.store ? field.store(value, previous) : value,
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
