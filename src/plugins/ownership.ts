/**
 * Built-in module ids and the state namespace each one's state lives in now.
 * Every key does two jobs: config, sync and session state saved under it is
 * rewritten to that namespace, and it is reserved, because an external plugin
 * using it would have its state merged in the same way. A module that moves
 * out to an external plugin leaves this map so that plugin can claim its id.
 *
 * A switched-off module id in `disabledPlugins` follows this map too, unless
 * BUILTIN_DISABLED_PLUGIN_ALIASES sends it somewhere else.
 */
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
  "fx-matrix": "market-overview",
  help: "application",
  holders: "ticker-research",
  insider: "ticker-research",
  jobs: "ticker-research",
  "dividend-yield": "ticker-research",
  executives: "ticker-research",
  "filing-events": "ticker-research",
  "risk-factors": "ticker-research",
  "short-interest": "ticker-research",
  "crypto-board": "market-overview",
  "short-volume": "ticker-research",
  "social-mentions": "ticker-research",
  "kelly-sizer": "portfolio",
  "layout-manager": "application",
  "macro-tv": "macro",
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

/**
 * Retired ids in `disabledPlugins` whose plugin is not the namespace their
 * state moved to: once a plugin is split, a module's state stays where it was
 * while its switch belongs to the successor that holds the module now.
 */
const BUILTIN_DISABLED_PLUGIN_ALIASES: Record<string, string> = {
  correlation: "quant",
  "crypto-board": "crypto",
  "earnings-calendar": "earnings",
  "earnings-calls": "earnings",
  "fx-matrix": "global-markets",
  "market-movers": "screeners",
  sectors: "global-markets",
  "world-indices": "global-markets",
  // `macro-tv` keeps meaning all of Macro: TV left for its own repository, so
  // no successor holds it, and turning it off was turning Macro off.
};

/**
 * Retired built-in plugin ids that now stand for a group of built-ins in
 * `disabledPlugins`, reserved for good. Turning the old plugin off, here or in
 * an older app through sync, turns off every successor holding one of its
 * modules; the old id is written back only while all of them are off, so an
 * older app shows it off exactly then, and turning it back on there brings
 * them all back.
 */
const BUILTIN_PLUGIN_GROUPS: Readonly<Record<string, readonly string[]>> = {
  macro: ["rates-macro", "credit", "earnings"],
  "market-overview": ["global-markets", "screeners", "futures-commodities", "crypto", "alt-data", "quant"],
};

let pluginGroups = BUILTIN_PLUGIN_GROUPS;

/** Pins the group table for a test; pass null to restore the real one. */
export function setBuiltinPluginGroupsForTests(groups: Readonly<Record<string, readonly string[]>> | null): void {
  pluginGroups = groups ?? BUILTIN_PLUGIN_GROUPS;
}

/** The built-ins a retired group id stands for, or null when the id is not a group. */
export function builtinPluginGroupMembers(pluginId: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(pluginGroups, pluginId) ? pluginGroups[pluginId]! : null;
}

/** The one built-in that cannot be disabled; its legacy module ids normalize to it. */
const NON_TOGGLEABLE_BUILTIN_PLUGIN_ID = "application";

const LEGACY_MODULE_IDS_BY_OWNER: Record<string, readonly string[]> = {
  application: ["layout-manager", "help", "changelog"],
  portfolio: ["portfolio-list", "analytics", "kelly-sizer"],
};

function normalizeBuiltinPluginOwnerId(pluginId: string): string {
  return BUILTIN_PLUGIN_OWNER_ALIASES[pluginId] ?? pluginId;
}

/** Every retired built-in module id, for checks that each still lands on the right plugin. */
export function retiredBuiltinModuleIds(): string[] {
  return Object.keys(BUILTIN_PLUGIN_OWNER_ALIASES);
}

export function isReservedBuiltinPluginId(pluginId: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PLUGIN_OWNER_ALIASES, pluginId)
    || builtinPluginGroupMembers(pluginId) !== null;
}

function normalizeBuiltinDisabledPluginId(pluginId: string): string {
  return BUILTIN_DISABLED_PLUGIN_ALIASES[pluginId] ?? normalizeBuiltinPluginOwnerId(pluginId);
}

/**
 * Rewrites retired module ids to the plugin that holds the module now. Group
 * ids are left as they are: the configuration migrations after this one read
 * them before `expandBuiltinPluginGroups` runs.
 */
export function normalizeBuiltinDisabledPluginIds(pluginIds: readonly string[]): string[] {
  return [...new Set(
    pluginIds
      .map(normalizeBuiltinDisabledPluginId)
      .filter((pluginId) => pluginId !== NON_TOGGLEABLE_BUILTIN_PLUGIN_ID),
  )];
}

/**
 * `disabledPlugins` as saved, in the ids the registry knows: a retired group
 * id becomes every member. Applied on every load, after the migrations; it
 * only ever adds switched-off plugins, and running it twice changes nothing.
 */
export function expandBuiltinPluginGroups(pluginIds: readonly string[]): string[] {
  return [...new Set(pluginIds.flatMap((pluginId) => builtinPluginGroupMembers(pluginId) ?? [pluginId]))];
}

/**
 * `disabledPlugins` as pulled. Another device may run an app from before
 * modules were merged or plugins split, so retired module ids are rewritten
 * as the migrations would, then groups expanded.
 */
export function decodeBuiltinDisabledPluginIds(pluginIds: readonly string[]): string[] {
  return expandBuiltinPluginGroups(normalizeBuiltinDisabledPluginIds(pluginIds));
}

/**
 * `disabledPlugins` as written to disk and pushed: a group whose members are
 * all off is written as its retired id alone, where its first member stood,
 * and a group partly off as the members that are. Expanding the result gives
 * the list back.
 */
export function encodeBuiltinDisabledPluginIds(pluginIds: readonly string[]): string[] {
  const disabled = new Set(pluginIds);
  const fullyOff = Object.entries(pluginGroups)
    .filter(([, members]) => members.length > 0 && members.every((member) => disabled.has(member)));
  if (fullyOff.length === 0) return [...disabled];
  const groupAt = new Map<string, string[]>();
  for (const [groupId, members] of fullyOff) {
    const first = pluginIds.find((pluginId) => members.includes(pluginId))!;
    groupAt.set(first, [...(groupAt.get(first) ?? []), groupId]);
  }
  const covered = new Set(fullyOff.flatMap(([, members]) => members));
  return [...new Set(pluginIds.flatMap((pluginId) => [
    ...(groupAt.get(pluginId) ?? []),
    ...(covered.has(pluginId) ? [] : [pluginId]),
  ]))];
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


