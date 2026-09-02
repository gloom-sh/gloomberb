const BUILTIN_PLUGIN_OWNER_ALIASES: Record<string, string> = {
  analytics: "portfolio",
  "broker-manager": "broker",
  changelog: "application",
  "company-research": "ticker-research",
  "chart-composer": "ticker-research",
  "comparison-chart": "ticker-research",
  correlation: "market-overview",
  "earnings-calendar": "macro",
  "earnings-calls": "macro",
  "ipo-calendar": "macro",
  "fear-greed": "market-overview",
  "fx-matrix": "market-overview",
  help: "application",
  holders: "ticker-research",
  insider: "ticker-research",
  "dividend-yield": "ticker-research",
  "short-interest": "ticker-research",
  "kelly-sizer": "portfolio",
  "layout-manager": "application",
  "macro-tv": "macro",
  "market-heatmap": "market-overview",
  "market-movers": "market-overview",
  options: "ticker-research",
  "portfolio-list": "portfolio",
  research: "ticker-research",
  sectors: "market-overview",
  sec: "ticker-research",
  thirteenf: "ticker-research",
  "ticker-detail": "ticker-research",
  "world-indices": "market-overview",
};

const NON_TOGGLEABLE_BUILTIN_PLUGIN_IDS = new Set([
  "application",
  "changelog",
  "help",
  "layout-manager",
]);

const LEGACY_MODULE_IDS_BY_OWNER: Record<string, readonly string[]> = {
  application: ["layout-manager", "help", "changelog"],
  portfolio: ["portfolio-list", "analytics", "kelly-sizer"],
};

export function normalizeBuiltinPluginOwnerId(pluginId: string): string {
  return BUILTIN_PLUGIN_OWNER_ALIASES[pluginId] ?? pluginId;
}

export function isReservedBuiltinPluginId(pluginId: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PLUGIN_OWNER_ALIASES, pluginId);
}

export function isNonToggleableBuiltinPluginId(pluginId: string): boolean {
  return NON_TOGGLEABLE_BUILTIN_PLUGIN_IDS.has(pluginId);
}

export function normalizeBuiltinDisabledPluginIds(pluginIds: readonly string[]): string[] {
  return [...new Set(
    pluginIds
      .filter((pluginId) => !isNonToggleableBuiltinPluginId(pluginId))
      .map(normalizeBuiltinPluginOwnerId)
      .filter((pluginId) => !isNonToggleableBuiltinPluginId(pluginId)),
  )];
}

export function normalizeBuiltinPluginStateMap(
  value: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).reduce<Array<[string, Record<string, unknown>]>>((entries, [pluginId, state]) => {
      const normalizedPluginId = normalizeBuiltinPluginOwnerId(pluginId);
      const existing = entries.find(([entryPluginId]) => entryPluginId === normalizedPluginId);
      if (existing) {
        existing[1] = pluginId === normalizedPluginId
          ? { ...existing[1], ...state }
          : { ...state, ...existing[1] };
      } else {
        entries.push([normalizedPluginId, { ...state }]);
      }
      return entries;
    }, []),
  );
}

/**
 * Keeps config snapshots readable by clients from before built-in modules were
 * consolidated. Current clients normalize these aliases back to their owner.
 */
export function addLegacyBuiltinPluginOwnerAliases(
  value: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const output = Object.fromEntries(
    Object.entries(value).map(([pluginId, state]) => [pluginId, { ...state }]),
  );
  for (const [ownerId, legacyIds] of Object.entries(LEGACY_MODULE_IDS_BY_OWNER)) {
    const ownerState = value[ownerId];
    if (!ownerState) continue;
    for (const legacyId of legacyIds) {
      output[legacyId] ??= { ...ownerState };
    }
  }
  return output;
}

export function addLegacyBuiltinDisabledPluginAliases(pluginIds: readonly string[]): string[] {
  const output = new Set(pluginIds);
  for (const pluginId of pluginIds) {
    for (const legacyId of LEGACY_MODULE_IDS_BY_OWNER[pluginId] ?? []) {
      output.add(legacyId);
    }
  }
  return [...output];
}

function isPluginStateMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

export function normalizeBuiltinPaneStatePluginOwners(
  paneState: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(paneState).map(([paneId, state]) => [
      paneId,
      isPluginStateMap(state.pluginState)
        ? { ...state, pluginState: normalizeBuiltinPluginStateMap(state.pluginState) }
        : state,
    ]),
  );
}

export function addLegacyBuiltinPaneStatePluginAliases(
  paneState: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(paneState).map(([paneId, state]) => [
      paneId,
      isPluginStateMap(state.pluginState)
        ? { ...state, pluginState: addLegacyBuiltinPluginOwnerAliases(state.pluginState) }
        : state,
    ]),
  );
}
