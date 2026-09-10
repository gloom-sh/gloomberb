import type { DataTableColumn } from "../../../components";
import type { ColumnConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { compareSortValues } from "../../../utils/sort-values";
import { getSortValue, type ColumnContext } from "../portfolio-list/metrics";

type SectorColumnId = "sector" | "weight" | "value" | "pnl" | "return" | "bar";

export interface SectorTableColumn extends DataTableColumn {
  id: SectorColumnId;
}

export interface SectorTableRow {
  id: string;
  sector: string;
  weight: number | null;
  value: number | null;
  pnl: number | null;
  returnPct: number | null;
  costBasis: number | null;
}

export interface PortfolioSectorAllocation {
  rows: SectorTableRow[];
  unvaluedSymbols: string[];
  fundSymbols: string[];
}

export interface SectorSortPreference {
  columnId: SectorColumnId | null;
  direction: "asc" | "desc";
}

export const DEFAULT_SECTOR_SORT: SectorSortPreference = {
  columnId: "weight",
  direction: "desc",
};

const PORTFOLIO_VALUE_COLUMN: ColumnConfig = { id: "mkt_value", label: "VALUE", width: 10, align: "right" };
const PORTFOLIO_PNL_COLUMN: ColumnConfig = { id: "pnl", label: "P&L", width: 10, align: "right" };
const PORTFOLIO_COST_COLUMN: ColumnConfig = { id: "cost_basis", label: "COST", width: 10, align: "right" };

export function buildSectorColumns(width: number): SectorTableColumn[] {
  const sectorWidth = Math.max(12, Math.min(22, Math.floor(width * 0.28)));
  const weightWidth = 8;
  const valueWidth = 10;
  const pnlWidth = 10;
  const returnWidth = 8;
  const barWidth = Math.max(8, width - sectorWidth - weightWidth - valueWidth - pnlWidth - returnWidth - 10);

  return [
    { id: "sector", label: "SECTOR", width: sectorWidth, align: "left" },
    { id: "weight", label: "WEIGHT", width: weightWidth, align: "right" },
    { id: "value", label: "VALUE", width: valueWidth, align: "right" },
    { id: "pnl", label: "P&L", width: pnlWidth, align: "right" },
    { id: "return", label: "P&L %", width: returnWidth, align: "right" },
    { id: "bar", label: "ALLOCATION", width: barWidth, align: "left" },
  ];
}

export function getPortfolioPositionValue(
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  columnContext: ColumnContext,
): number | null {
  const value = getSortValue(PORTFOLIO_VALUE_COLUMN, ticker, financials, columnContext);
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function getSectorSortValue(row: SectorTableRow, columnId: SectorColumnId): string | number | null {
  switch (columnId) {
    case "sector":
      return row.sector;
    case "value":
      return row.value;
    case "pnl":
      return row.pnl;
    case "return":
      return row.returnPct;
    case "bar":
    case "weight":
      return row.weight;
  }
}

export function buildTrackedCurrencies(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  baseCurrency: string,
): string[] {
  const currencies = new Set<string>([baseCurrency]);

  for (const ticker of tickers) {
    if (ticker.metadata.currency) {
      currencies.add(ticker.metadata.currency);
    }
    for (const position of ticker.metadata.positions) {
      if (position.currency) {
        currencies.add(position.currency);
      }
    }
    const financials = financialsMap.get(ticker.metadata.ticker);
    if (financials?.quote?.currency) {
      currencies.add(financials.quote.currency);
    }
  }

  return [...currencies];
}

export function buildSectorRowsFromPortfolioColumns(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  columnContext: ColumnContext,
): PortfolioSectorAllocation {
  const sectorMap = new Map<string, {
    sector: string;
    value: number | null;
    pnl: number | null;
    costBasis: number | null;
  }>();
  const unvaluedSymbols: string[] = [];
  const fundSymbols: string[] = [];
  const addKnown = (total: number | null, value: unknown): number | null => (
    total != null && typeof value === "number" && Number.isFinite(value) ? total + value : null
  );

  for (const ticker of tickers) {
    const financials = financialsMap.get(ticker.metadata.ticker);
    const value = getPortfolioPositionValue(ticker, financials, columnContext);
    if (value == null) unvaluedSymbols.push(ticker.metadata.ticker);

    const pnl = getSortValue(PORTFOLIO_PNL_COLUMN, ticker, financials, columnContext);
    const costBasis = getSortValue(PORTFOLIO_COST_COLUMN, ticker, financials, columnContext);
    const isFund = [ticker.metadata.assetCategory, financials?.quote?.instrumentType]
      .some((type) => /^(ETF|ETN|FUND|MUTUALFUND|MUTUAL_FUND)$/i.test(type ?? ""));
    if (isFund) fundSymbols.push(ticker.metadata.ticker);
    const sector = isFund ? "Funds" : ticker.metadata.sector || financials?.profile?.sector || "Unknown";
    const current = sectorMap.get(sector) ?? {
      sector,
      value: 0,
      pnl: 0,
      costBasis: 0,
    };

    current.value = addKnown(current.value, value);
    current.pnl = addKnown(current.pnl, pnl);
    current.costBasis = addKnown(current.costBasis, costBasis);
    sectorMap.set(sector, current);
  }

  const totalValue = unvaluedSymbols.length === 0
    ? [...sectorMap.values()].reduce((sum, row) => sum + (row.value ?? 0), 0) : null;

  const rows = [...sectorMap.values()]
    .map((row) => ({
      ...row,
      id: row.sector,
      weight: row.value != null && totalValue != null && totalValue > 0 ? row.value / totalValue : null,
      returnPct: row.pnl != null && row.costBasis != null && row.costBasis !== 0 ? (row.pnl / row.costBasis) * 100 : null,
    }))
    .sort((left, right) => compareSortValues(left.weight, right.weight, "desc") || left.sector.localeCompare(right.sector));
  return { rows, unvaluedSymbols, fundSymbols };
}

export function sortSectorRows(rows: SectorTableRow[], sort: SectorSortPreference): SectorTableRow[] {
  const columnId = sort.columnId;
  if (!columnId) return rows;

  return [...rows].sort((left, right) => {
    const leftValue = getSectorSortValue(left, columnId);
    const rightValue = getSectorSortValue(right, columnId);
    return compareSortValues(leftValue, rightValue, sort.direction);
  });
}

export function nextSectorSortPreference(current: SectorSortPreference, columnId: string): SectorSortPreference {
  const nextColumnId = columnId as SectorColumnId;
  if (current.columnId !== nextColumnId) {
    return { columnId: nextColumnId, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { columnId: nextColumnId, direction: "desc" };
  }
  return { columnId: null, direction: "asc" };
}
