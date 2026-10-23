import { formatTickerListInput, parseTickerListInput } from "../../../tickers/list";

type EarningsSymbols = { text: string } & (
  | { symbols: string[]; error: null }
  | { symbols: null; error: string }
);

/** Invalid input stays editable and can never stand for the unscoped market board. */
export function scopedSymbolsFromSettings(settings: Record<string, unknown> | undefined): EarningsSymbols {
  const symbols = settings?.symbols;
  const text = Array.isArray(symbols)
    ? formatTickerListInput(symbols.filter((symbol): symbol is string => typeof symbol === "string" && symbol.trim().length > 0))
    : typeof settings?.symbolsText === "string" ? settings.symbolsText : "";
  if (!text.trim()) return { symbols: [], error: null, text: "" };
  try {
    const parsed = parseTickerListInput(text);
    return { symbols: parsed, error: null, text: formatTickerListInput(parsed) };
  } catch (error) {
    // Intentional ignore: user input validation becomes a visible, editable error state.
    return { symbols: null, error: error instanceof Error ? error.message : "Invalid ticker list.", text };
  }
}
