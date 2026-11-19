type MatchText = string | null | undefined;

/** Rank already-filtered results without disturbing the current sort within a match group. */
export function rankTickerMatches<Row>(
  rows: Row[],
  query: string,
  fields: (row: Row) => readonly [ticker: MatchText, ...names: MatchText[]],
): Row[] {
  const needle = query.trim().toLowerCase();
  if (!needle || rows.length < 2) return rows;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordStart = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, "u");
  const exact: Row[] = [], prefix: Row[] = [], word: Row[] = [], other: Row[] = [];
  for (const row of rows) {
    const [ticker, ...names] = fields(row);
    const symbol = ticker?.toLowerCase();
    if (symbol === needle) exact.push(row);
    else if (symbol?.startsWith(needle)) prefix.push(row);
    else if (names.some((name) => name && wordStart.test(name.toLowerCase()))) word.push(row);
    else other.push(row);
  }
  return exact.concat(prefix, word, other);
}
