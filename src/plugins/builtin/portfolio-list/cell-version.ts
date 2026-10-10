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
  "drift",
  "trade",
  "trade_value",
  "day_pnl",
  "pnl",
  "pnl_pct",
]);
/** Columns that divide by the portfolio's total. */
const ALLOCATION_COLUMN_IDS = new Set(["weight", "drift", "trade", "trade_value"]);
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

const targetVersions = new WeakMap<Readonly<Record<string, number>>, string>();

function targetsVersion(targets: Readonly<Record<string, number>> | undefined): string {
  if (!targets) return "";
  let version = targetVersions.get(targets);
  if (version == null) {
    version = Object.entries(targets).sort(([left], [right]) => left.localeCompare(right)).map(([symbol, weight]) => `${symbol}:${weight}`).join(",");
    targetVersions.set(targets, version);
  }
  return version;
}

export function columnContextVersion(columnId: string, ctx: ColumnContext): string {
  let version = `${ctx.activeTab ?? ""}|${ctx.baseCurrency}`;
  if (FX_COLUMN_IDS.has(columnId)) version += `|${exchangeRatesVersion(ctx.exchangeRates)}`;
  if (ALLOCATION_COLUMN_IDS.has(columnId)) version += `|${ctx.portfolioTotalMarketValue ?? 0}`;
  if (ALLOCATION_COLUMN_IDS.has(columnId) || columnId === "target_weight") version += `|${targetsVersion(ctx.portfolioTargets)}`;
  if (SUPPLEMENTAL_COLUMN_IDS.has(columnId)) version += `|${ctx.supplementalVersion ?? 0}`;
  if (columnId === "latency") version += `|${ctx.now}`;
  if (DAY_CLOCK_COLUMN_IDS.has(columnId)) version += `|${Math.floor(ctx.now / DAY_MS)}`;
  return version;
}

export function columnUsesClock(columnId: string): "age" | "day" | null {
  if (columnId === "latency") return "age";
  return DAY_CLOCK_COLUMN_IDS.has(columnId) ? "day" : null;
}
