import { parseTickerListInput } from "../../../tickers/list";

export function scopedSymbolsFromSettings(settings: Record<string, unknown> | undefined): string[] {
  const symbols = settings?.symbols;
  if (Array.isArray(symbols)) {
    return symbols
      .filter((symbol): symbol is string => typeof symbol === "string" && symbol.trim().length > 0)
      .map((symbol) => symbol.trim().toUpperCase());
  }
  const symbolsText = settings?.symbolsText;
  if (typeof symbolsText !== "string" || !symbolsText.trim()) return [];
  try {
    return parseTickerListInput(symbolsText);
  } catch {
    return [];
  }
}
