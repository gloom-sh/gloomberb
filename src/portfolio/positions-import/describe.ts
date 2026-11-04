/**
 * The words a positions import is shown in, the same in `portfolio import`
 * and in the app's preview: where the file comes from, the portfolio it
 * makes, and each row's shares, cost and status.
 */
import { formatMarketCostWithCurrency, formatMarketQuantity } from "../../market-data/market/format";
import { POSITIONS_LAYOUT_NAMES, type PositionsLayoutId } from "./parse";
import type { PositionsImportRow } from "./plan";

/** The broker a recognised export comes from, which names the portfolio it makes. */
const LAYOUT_PORTFOLIO_NAMES: Readonly<Record<Exclude<PositionsLayoutId, "generic">, string>> = {
  fidelity: "Fidelity",
  schwab: "Schwab",
  vanguard: "Vanguard",
  etrade: "E*TRADE",
  merrill: "Merrill",
};

/** The file's name without its folder; null for standard input. */
function fileBaseName(path: string | null): string | null {
  if (!path || path === "-") return null;
  return path.split(/[\\/]/).pop() || null;
}

/** The portfolio a file makes when none is named: the broker's name, else the file's. */
export function defaultImportPortfolioName(layout: PositionsLayoutId, path: string | null): string {
  if (layout !== "generic") return LAYOUT_PORTFOLIO_NAMES[layout];
  return fileBaseName(path)?.replace(/\.[^.]+$/, "").trim() || "Imported positions";
}

/** Where the positions come from, after "from": "the Fidelity positions export", "holdings.csv". */
export function positionsImportSource(layout: PositionsLayoutId, path: string | null): string {
  if (layout !== "generic") return `the ${POSITIONS_LAYOUT_NAMES[layout]}`;
  return fileBaseName(path) ?? "standard input";
}

export function positionsImportShares(row: PositionsImportRow): string {
  return formatMarketQuantity(row.shares, { assetCategory: row.ticker.metadata.assetCategory });
}

/** Per share in the position's currency; a cost the holding keeps says so, and none is a dash. */
export function positionsImportCost(row: PositionsImportRow): string {
  if (row.avgCost === null) return "—";
  const cost = formatMarketCostWithCurrency(row.avgCost, row.currency, { assetCategory: row.ticker.metadata.assetCategory });
  return row.keptCost ? `${cost} (kept)` : cost;
}

/** New, or what the portfolio held before. */
export function positionsImportStatus(row: PositionsImportRow): string {
  if (row.heldShares === null) return "new";
  return row.heldShares === row.shares ? "same shares" : `was ${formatMarketQuantity(row.heldShares)}`;
}
