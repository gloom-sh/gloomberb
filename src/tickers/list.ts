
export const MAX_TICKER_LIST_SIZE = 10;

function normalizeTickerToken(value: string): string {
  return value.trim().toUpperCase();
}

export function parseTickerListInput(raw: string, maxTickers = MAX_TICKER_LIST_SIZE): string[] {
  const tokens = raw
    .split(/[,\s]+/)
    .map(normalizeTickerToken)
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }

  if (unique.length === 0) {
    throw new Error("Enter at least one ticker.");
  }

  if (unique.length > maxTickers) {
    throw new Error(`You can compare up to ${maxTickers} tickers.`);
  }

  return unique;
}

export function formatTickerListInput(symbols: string[]): string {
  return symbols.join(", ");
}
