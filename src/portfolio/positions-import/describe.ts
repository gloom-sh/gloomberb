/**
 * The words a positions import is shown in, the same in `portfolio import`
 * and in the app's preview: where the file comes from, the portfolio it
 * makes, and each row's shares, cost and status.
 */
import { formatMarketCost, formatMarketCostWithCurrency, formatMarketQuantity, withCurrencyMinorDigits } from "../../market-data/market/format";
import { POSITIONS_LAYOUT_NAMES, type PositionsLayoutId } from "./parse";
import { sameCost, type PositionsImportRow } from "./plan";

/** The rows a preview lists of each kind; past this many, a line counts the rest. */
export const PREVIEW_ROWS_SHOWN = 100;

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

/**
 * Per share in the position's currency: as PF's Avg Cost prints it (158.57,
 * the currency in its own column), or with the currency's sign as `portfolio
 * show` prints it ($158.57). A cost the holding keeps says so, and none is a
 * dash.
 */
export function positionsImportCost(row: PositionsImportRow, { withCurrency = false }: { withCurrency?: boolean } = {}): string {
  if (row.avgCost === null) return "—";
  const options = { assetCategory: row.ticker.metadata.assetCategory };
  const cost = withCurrency
    ? formatMarketCostWithCurrency(row.avgCost, row.currency, options)
    : formatMarketCost(row.avgCost, withCurrencyMinorDigits(options, row.currency));
  return row.keptCost ? `${cost} (kept)` : cost;
}

/**
 * Whether the rows need a currency column: some are in another currency
 * than the portfolio totals in. A portfolio with no positions yet takes its
 * first position's, so one currency across the rows needs none.
 */
export function positionsImportShowsCurrency(rows: readonly PositionsImportRow[], portfolioCurrency: string | null): boolean {
  const currencies = new Set(rows.map((row) => row.currency));
  return currencies.size > 1 || (portfolioCurrency !== null && currencies.size === 1 && !currencies.has(portfolioCurrency));
}

/** What the import does to a holding: new, its lots made one, its shares, cost or date changed, or nothing. */
export function positionsImportStatus(row: PositionsImportRow): string {
  if (row.heldShares === null) return "new";
  if (row.heldLots > 1) return `${row.heldLots} lots → 1`;
  if (row.heldShares !== row.shares) return `was ${formatMarketQuantity(row.heldShares)}`;
  if (!row.keptCost && row.avgCost !== null && (row.heldAvgCost === null || !sameCost(row.heldAvgCost, row.avgCost))) return "new cost";
  if (row.dateAcquired && row.dateAcquired !== row.heldDate) return "new date";
  return "unchanged";
}

/** The line under a skipped list cut at `PREVIEW_ROWS_SHOWN`, or null when it lists them all. */
export function moreSkippedLine(total: number): string | null {
  const more = total - PREVIEW_ROWS_SHOWN;
  return more > 0 ? `and ${more.toLocaleString("en-US")} more row${more === 1 ? "" : "s"} skipped` : null;
}

/** The line under a positions list cut at `PREVIEW_ROWS_SHOWN`: the rest are imported all the same. */
export function morePositionsLine(total: number): string | null {
  const more = total - PREVIEW_ROWS_SHOWN;
  return more > 0 ? `and ${more.toLocaleString("en-US")} more position${more === 1 ? "" : "s"}, imported with these` : null;
}
