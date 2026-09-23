import type { ColumnContext } from "./column-values";

const DAY_MS = 86_400_000;

// What each column reads from the context besides the pane's collection and
// base currency. A quote tick changes one row's financials; these keep an FX
// refresh, a new portfolio total or a clock tick from recomputing every cell.
const FX_COLUMN_IDS = new Set([
  "dollar_volume",
  "market_cap",
  "cost_basis",
  "mkt_value",
  "weight",
  "day_pnl",
  "pnl",
  "pnl_pct",
]);
const SUPPLEMENTAL_COLUMN_IDS = new Set(["target", "target_pct", "rating", "ex_div", "next_earn"]);
const DAY_CLOCK_COLUMN_IDS = new Set(["held", "ex_div", "next_earn"]);

const exchangeRateVersions = new WeakMap<ReadonlyMap<string, number>, string>();

/** Content version: a rebuilt map with the same rates is the same version. */
function exchangeRatesVersion(rates: ReadonlyMap<string, number>): string {
  const cached = exchangeRateVersions.get(rates);
  if (cached != null) return cached;
  const version = [...rates]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, rate]) => `${currency}:${rate}`)
    .join(",");
  exchangeRateVersions.set(rates, version);
  return version;
}

export function columnContextVersion(columnId: string, ctx: ColumnContext): string {
  let version = `${ctx.activeTab ?? ""}|${ctx.baseCurrency}`;
  if (FX_COLUMN_IDS.has(columnId)) version += `|${exchangeRatesVersion(ctx.exchangeRates)}`;
  if (columnId === "weight") version += `|${ctx.portfolioTotalMarketValue ?? 0}`;
  if (SUPPLEMENTAL_COLUMN_IDS.has(columnId)) version += `|${ctx.supplementalVersion ?? 0}`;
  if (columnId === "latency") version += `|${ctx.now}`;
  if (DAY_CLOCK_COLUMN_IDS.has(columnId)) version += `|${Math.floor(ctx.now / DAY_MS)}`;
  return version;
}

export function columnUsesClock(columnId: string): "age" | "day" | null {
  if (columnId === "latency") return "age";
  return DAY_CLOCK_COLUMN_IDS.has(columnId) ? "day" : null;
}
