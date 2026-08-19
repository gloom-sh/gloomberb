import { TextAttributes } from "../../../ui";
import type { DataTableCell } from "../../../components";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { blendHex, colors, hoverBg } from "../../../theme/colors";
import { blendForContrast, contrastRatio } from "../../../theme/color-utils";
import { formatCompact, formatNumber } from "../../../utils/format";
import { formatMarketPrice } from "../../../market-data/market/format";
import type { OptionColumn, OptionColumnId, OptionTableRow } from "./types";

type OptionColorRole = "call" | "put" | "price" | "activity" | "iv" | "strike";

const OPTION_TEXT_MIN_CONTRAST = 4.5;

export const OPTION_COLUMNS: Array<Omit<OptionColumn, "headerColor">> = [
  { id: "callOpenInterest", label: "C OI", width: 6, align: "right" },
  { id: "callVolume", label: "C VOL", width: 6, align: "right" },
  { id: "callLast", label: "C LAST", width: 7, align: "right" },
  { id: "callIv", label: "C IV", width: 6, align: "right" },
  { id: "callBid", label: "C BID", width: 7, align: "right" },
  { id: "callAsk", label: "C ASK", width: 7, align: "right" },
  { id: "strike", label: "STRIKE", width: 9, align: "right" },
  { id: "putBid", label: "P BID", width: 7, align: "right" },
  { id: "putAsk", label: "P ASK", width: 7, align: "right" },
  { id: "putIv", label: "P IV", width: 6, align: "right" },
  { id: "putLast", label: "P LAST", width: 7, align: "right" },
  { id: "putVolume", label: "P VOL", width: 6, align: "right" },
  { id: "putOpenInterest", label: "P OI", width: 6, align: "right" },
];

export function buildStrikeList(chain: OptionsChain): number[] {
  const set = new Set<number>();
  for (const c of chain.calls) set.add(c.strike);
  for (const p of chain.puts) set.add(p.strike);
  return Array.from(set).sort((a, b) => a - b);
}

export function resolveDefaultStrikeTarget(
  optionStrike: number | undefined,
  quotePrice: number | undefined,
): number | null {
  if (optionStrike != null && Number.isFinite(optionStrike)) return optionStrike;
  if (quotePrice != null && Number.isFinite(quotePrice)) return quotePrice;
  return null;
}

export function findNearestStrikeIndex(strikes: number[], targetStrike: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < strikes.length; index += 1) {
    const distance = Math.abs(strikes[index]! - targetStrike);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

export function formatStrikeLabel(strike: number): string {
  const decimals = strike % 1 === 0 ? 0 : 2;
  return formatNumber(strike, decimals).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

export function formatIv(value: number | undefined): string {
  // Providers send 0 for contracts with no implied volatility; "0.0%" would read
  // as a real quote of zero vol.
  if (value == null || !Number.isFinite(value) || value <= 0) return "\u2014";
  return `${(value * 100).toFixed(1)}%`;
}

export function optionColumnColor(columnId: OptionColumnId, surface = colors.bg): string {
  return optionRoleColor(optionColumnRole(columnId), surface);
}

function optionContractForColumn(row: OptionTableRow, columnId: OptionColumnId): OptionContract | undefined {
  return columnId.startsWith("call") ? row.call : row.put;
}

function optionColumnRole(columnId: OptionColumnId): OptionColorRole {
  if (columnId === "strike") return "strike";
  if (columnId.endsWith("Iv")) return "iv";
  if (columnId.endsWith("Volume") || columnId.endsWith("OpenInterest")) return "activity";
  if (columnId.endsWith("Bid") || columnId.endsWith("Ask")) return "price";
  return columnId.startsWith("call") ? "call" : "put";
}

function optionRoleThemeColor(role: OptionColorRole): string {
  switch (role) {
    case "call":
    case "iv":
      return colors.positive;
    case "put":
      return colors.negative;
    case "price":
      return colors.warning;
    case "activity":
    case "strike":
      return colors.borderFocused;
  }
}

function mostReadableColor(surface: string, candidates: readonly string[]): string {
  return candidates.reduce((best, candidate) =>
    contrastRatio(candidate, surface) > contrastRatio(best, surface) ? candidate : best,
  );
}

function optionRoleColor(role: OptionColorRole, surface: string): string {
  const preferred = optionRoleThemeColor(role);
  const fallback = mostReadableColor(surface, [
    preferred,
    colors.text,
    colors.textBright,
    colors.selectedText,
    colors.neutral,
  ]);
  return blendForContrast(preferred, surface, fallback, OPTION_TEXT_MIN_CONTRAST);
}

function optionMutedColor(surface: string): string {
  const fallback = mostReadableColor(surface, [
    colors.textDim,
    colors.text,
    colors.textBright,
    colors.selectedText,
    colors.neutral,
  ]);
  return blendForContrast(colors.textDim, surface, fallback, OPTION_TEXT_MIN_CONTRAST);
}

function optionMoneynessBackground(
  row: OptionTableRow,
  contract: OptionContract | undefined,
  columnId: OptionColumnId,
  rowState: { selected: boolean },
): string | undefined {
  if (rowState.selected) return undefined;
  const inTheMoney = inferColumnMoneyness(row, contract, columnId);
  const sideColor = columnId.startsWith("call") ? colors.positive : colors.negative;
  return inTheMoney
    ? blendHex(colors.bg, sideColor, 0.13)
    : blendHex(colors.bg, colors.neutral, 0.055);
}

function inferColumnMoneyness(
  row: OptionTableRow,
  contract: OptionContract | undefined,
  columnId: OptionColumnId,
): boolean {
  if (contract) return contract.inTheMoney;
  const oppositeContract = columnId.startsWith("call") ? row.put : row.call;
  return oppositeContract ? !oppositeContract.inTheMoney : false;
}

function formatOptionContractCell(contract: OptionContract | undefined, column: OptionColumn): string {
  if (!contract) return "—";
  switch (column.id) {
    case "callLast":
    case "putLast":
      return formatMarketPrice(contract.lastPrice, { assetCategory: "OPT", maxWidth: column.width });
    case "callBid":
    case "putBid":
      return formatMarketPrice(contract.bid, { assetCategory: "OPT", maxWidth: column.width });
    case "callAsk":
    case "putAsk":
      return formatMarketPrice(contract.ask, { assetCategory: "OPT", maxWidth: column.width });
    case "callVolume":
    case "putVolume":
      return formatCompact(contract.volume);
    case "callOpenInterest":
    case "putOpenInterest":
      return formatCompact(contract.openInterest);
    case "callIv":
    case "putIv":
      return formatIv(contract.impliedVolatility);
    case "strike":
      return formatStrikeLabel(contract.strike);
  }
}

export function renderOptionCell(
  row: OptionTableRow,
  column: OptionColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const rowSurface = rowState.selected ? colors.selected : colors.bg;

  if (column.id === "strike") {
    const backgroundColor = rowState.selected
      ? undefined
      : blendHex(colors.bg, row.isPositionStrike ? colors.borderFocused : colors.header, row.isPositionStrike ? 0.18 : 0.1);
    const surface = backgroundColor ?? rowSurface;
    return {
      text: formatStrikeLabel(row.strike),
      color: selectedColor ?? optionRoleColor("strike", surface),
      backgroundColor,
      attributes: rowState.selected || row.isPositionStrike ? TextAttributes.BOLD : TextAttributes.NONE,
    };
  }

  const contract = optionContractForColumn(row, column.id);
  const backgroundColor = optionMoneynessBackground(row, contract, column.id, rowState);
  const surface = backgroundColor ?? rowSurface;
  return {
    text: formatOptionContractCell(contract, column),
    color: selectedColor ?? (contract ? optionRoleColor(optionColumnRole(column.id), surface) : optionMutedColor(surface)),
    backgroundColor,
  };
}
