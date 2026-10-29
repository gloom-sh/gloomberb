import type { PaneSettingsContext, PaneSettingsDef } from "../../../types/plugin";
import { formatTickerListInput, parseTickerListInput } from "../../../tickers/list";
import { AUTO_PEERS_SETTING, PEER_SELECTION_SETTING, peerSelectionOf } from "./relative-valuation-peers";

/** The most tickers RV compares, as it reads its argument. */
export const MAX_RELATIVE_VALUATION_TICKERS = 12;

/** The tickers an RV pane compares: the list in its settings, else the ticker it is bound to. */
export function relativeSymbolsFromPane(symbol: string | null, paneSettings: Record<string, unknown> | undefined): string[] {
  const settingsSymbols = Array.isArray(paneSettings?.symbols)
    ? paneSettings.symbols.filter((value): value is string => typeof value === "string")
    : [];
  if (settingsSymbols.length > 0) return settingsSymbols;
  return symbol ? [symbol] : [];
}

/**
 * The pane's Tickers setting: the list it compares, with how its peers were
 * chosen while they are the ones picked. A list typed there is compared as
 * typed, one ticker alone included.
 */
export function buildRelativeValuationSettingsDef(context: PaneSettingsContext): PaneSettingsDef {
  const symbols = relativeSymbolsFromPane(null, context.settings);
  const selection = peerSelectionOf(context.settings[PEER_SELECTION_SETTING], symbols);
  return {
    title: "Relative Valuation Settings",
    values: { symbolsText: formatTickerListInput(symbols) },
    fields: [{
      key: "symbolsText",
      label: "Tickers",
      description: selection
        ? `Peers chosen automatically: ${selection.basis}. Edit the list to compare your own.`
        : `Enter up to ${MAX_RELATIVE_VALUATION_TICKERS} tickers separated by commas.`,
      type: "text",
      placeholder: "AAPL, MSFT, GOOGL",
    }],
    applyValue: (settings, field, value) => {
      if (field.key !== "symbolsText") return { ...settings, [field.key]: value };
      const next = parseTickerListInput(typeof value === "string" ? value : "", MAX_RELATIVE_VALUATION_TICKERS);
      const { [PEER_SELECTION_SETTING]: _picked, ...rest } = settings;
      return { ...rest, symbols: next, symbolsText: formatTickerListInput(next), [AUTO_PEERS_SETTING]: false };
    },
  };
}
