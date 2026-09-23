import type { QueryEntry } from "../../../market-data/result-types";

const iso = (time: number | null | undefined): string => {
  const date = new Date(time ?? NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
};

/** One record per USD leg; cross rates reference the row and column currencies. */
export function createFxExportMetadata(
  currencies: readonly string[],
  rates: ReadonlyMap<string, number>,
  read: (currency: string) => QueryEntry<number> | null | undefined,
  now = Date.now(),
): readonly (readonly unknown[])[] {
  return [
    ["Cross rate", "Row currency USD leg / column currency USD leg; same-currency cells are identity"],
    ["Currency", "USD per currency", "As of UTC", "Fetched at UTC", "Status", "Error"],
    ...currencies.map((currency) => {
      if (currency === "USD") return [currency, 1, "", "", "identity", ""];
      const entry = read(currency);
      const rate = rates.get(currency);
      const available = rate != null && Number.isFinite(rate) && rate > 0;
      const status: string[] = [];
      if (!available) status.push("unavailable");
      if (entry?.phase === "loading" || entry?.phase === "refreshing") status.push("loading");
      if (available && (entry?.error || (entry?.staleAt != null && entry.staleAt <= now))) status.push("stale");
      if (available && !iso(entry?.asOf)) status.push("time unknown");
      return [currency, available ? rate : "", iso(entry?.asOf), iso(entry?.fetchedAt),
        status.join("; ") || "current", entry?.error?.message ?? ""];
    }),
  ];
}
