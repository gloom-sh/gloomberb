/**
 * A security series' legend label with its company named once beside it
 * ("AAPL Price · Apple"), and the shorter label the legend falls back to when
 * the company is drawn once (`8058 Mitsubishi`). A name that starts with the
 * ticker names it once: CF in a comparison is "CF Industries", never
 * "CF CF Industries".
 */
export function companyLegendLabels(
  label: string,
  symbol: string | null,
  company: string,
  onlySeriesOfSymbol: boolean,
): { label: string; compactLabel?: string } {
  const tickerLed = !!symbol && company.toUpperCase().startsWith(`${symbol.toUpperCase()} `);
  return {
    label: tickerLed && label === symbol ? company : `${label} · ${company}`,
    ...(symbol && onlySeriesOfSymbol ? { compactLabel: tickerLed ? company : `${symbol} ${company}` } : {}),
  };
}
