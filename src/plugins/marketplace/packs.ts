/**
 * Starter packs: sets of the research built-ins to have on, so someone who
 * trades options or reads credit starts from a pane list that fits. A pack
 * only ever switches the plugins Ticker Research, Market Overview and Macro
 * were split into. Portfolio, News, Chat, Cloud, the other built-ins and
 * installed plugins stay as they are.
 */

/** The plugins packs switch, in the order the Plugins pane lists them. */
export const PACK_PLUGIN_IDS: readonly string[] = [
  "ticker-core",
  "options-volatility",
  "ownership",
  "filings",
  "earnings",
  "credit",
  "rates-macro",
  "global-markets",
  "screeners",
  "futures-commodities",
  "crypto",
  "alt-data",
  "quant",
];

export interface StarterPack {
  id: string;
  name: string;
  /** Ten words at most. */
  tagline: string;
  /** The pack plugins it keeps on; every other one goes off. */
  plugins: readonly string[];
}

/** Ticker Research is in every pack: DES, G and the research pane need it. */
export const STARTER_PACKS: readonly StarterPack[] = [
  {
    id: "everything",
    name: "Everything",
    tagline: "Every research plugin on, as Gloomberb ships.",
    plugins: PACK_PLUGIN_IDS,
  },
  {
    id: "equity-research",
    name: "Equity research",
    tagline: "Companies, filings, ownership, earnings and screens.",
    plugins: ["ticker-core", "ownership", "filings", "earnings", "screeners", "alt-data"],
  },
  {
    id: "options-desk",
    name: "Options desk",
    tagline: "Chains, volatility, flow, earnings moves and backtests.",
    plugins: ["ticker-core", "options-volatility", "earnings", "screeners", "quant"],
  },
  {
    id: "macro-rates",
    name: "Macro & rates",
    tagline: "Economy, curves, credit, futures and world markets.",
    plugins: ["ticker-core", "rates-macro", "credit", "futures-commodities", "global-markets", "quant"],
  },
  {
    id: "credit-bonds",
    name: "Credit & bonds",
    tagline: "CDS, spreads, covenants and filings, with the rates backdrop.",
    plugins: ["ticker-core", "credit", "rates-macro", "filings", "earnings"],
  },
  {
    id: "alt-data-quant",
    name: "Alt data & quant",
    tagline: "Supply chains, hiring, attention, ownership and backtests.",
    plugins: ["ticker-core", "alt-data", "quant", "ownership", "screeners"],
  },
];

/** What choosing a pack does from here, each list in pane order. */
export interface PackChange {
  turnOff: string[];
  turnOn: string[];
  /** On now and on in the pack. */
  keep: string[];
}

export function packChange(disabledPlugins: readonly string[], pack: StarterPack): PackChange {
  const disabled = new Set(disabledPlugins);
  const wanted = new Set(pack.plugins);
  const change: PackChange = { turnOff: [], turnOn: [], keep: [] };
  for (const id of PACK_PLUGIN_IDS) {
    if (wanted.has(id)) (disabled.has(id) ? change.turnOn : change.keep).push(id);
    else if (!disabled.has(id)) change.turnOff.push(id);
  }
  return change;
}

/** The switches that make a change, for one `setPluginsEnabled` call; empty when there is nothing to do. */
export function packToggles(change: PackChange): Record<string, boolean> {
  return Object.fromEntries([
    ...change.turnOff.map((id) => [id, false] as const),
    ...change.turnOn.map((id) => [id, true] as const),
  ]);
}

/** The pack whose plugins are exactly the ones on, or null for a custom set. */
export function matchingPack(disabledPlugins: readonly string[]): StarterPack | null {
  return STARTER_PACKS.find((pack) => {
    const change = packChange(disabledPlugins, pack);
    return change.turnOff.length === 0 && change.turnOn.length === 0;
  }) ?? null;
}

/**
 * The switches that put every pack plugin back the way `previous` had it,
 * for Undo. Nothing outside the pack plugins is named, so a plugin the user
 * switched in between keeps that state.
 */
export function restoreToggles(previousDisabledPlugins: readonly string[]): Record<string, boolean> {
  const disabled = new Set(previousDisabledPlugins);
  return Object.fromEntries(PACK_PLUGIN_IDS.map((id) => [id, !disabled.has(id)]));
}
