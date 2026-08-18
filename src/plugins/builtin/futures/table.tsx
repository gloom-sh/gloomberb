import type { DataTableCell, DataTableColumn } from "../../../components";
import { colors, priceColor } from "../../../theme/colors";
import type { Quote } from "../../../types/financials";
import { TextAttributes } from "../../../ui";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { marketStatusDot, type BoardQuoteMap } from "../shared/use-quote-board";
import type { FuturesContract } from "./contracts";
import type { FuturesColumnId, FuturesTableRow } from "./model";

export type FuturesColumn = DataTableColumn & { id: FuturesColumnId };

export interface FuturesColumnDef {
  id: FuturesColumnId;
  label: string;
  description: string;
}

export const FUTURES_COLUMN_DEFS: readonly FuturesColumnDef[] = [
  { id: "status", label: "Session", description: "Live trading session indicator." },
  { id: "code", label: "Symbol", description: "Exchange contract code." },
  { id: "name", label: "Contract", description: "Contract name." },
  { id: "price", label: "Last", description: "Last traded price." },
  { id: "change", label: "Change", description: "Change on the session." },
  { id: "changePercent", label: "Change %", description: "Percent change on the session." },
];

const DEFAULT_FUTURES_COLUMN_IDS = FUTURES_COLUMN_DEFS.map((column) => column.id);

const COLUMN_WIDTHS: Record<Exclude<FuturesColumnId, "name">, number> = {
  status: 1,
  code: 5,
  price: 12,
  change: 10,
  changePercent: 9,
};

export function createFuturesColumns(width: number, visibleIds?: readonly string[]): FuturesColumn[] {
  const ids = resolveFuturesColumnIds(visibleIds);
  const fixed = ids
    .filter((id): id is Exclude<FuturesColumnId, "name"> => id !== "name")
    .reduce((total, id) => total + COLUMN_WIDTHS[id], 0);
  const nameWidth = Math.max(10, width - 2 - ids.length - fixed);

  return ids.map((id) => {
    const label = FUTURES_HEADER_LABELS[id];
    if (id === "name") return { id, label, width: nameWidth, align: "left" };
    return {
      id,
      label,
      width: COLUMN_WIDTHS[id],
      align: id === "code" || id === "status" ? "left" : "right",
    };
  });
}

const FUTURES_HEADER_LABELS: Record<FuturesColumnId, string> = {
  status: "",
  code: "SYM",
  name: "CONTRACT",
  price: "LAST",
  change: "CHG",
  changePercent: "CHG%",
};

/** Falls back to the full column set when the saved selection is empty or unknown. */
export function resolveFuturesColumnIds(visibleIds?: readonly string[]): FuturesColumnId[] {
  const resolved = (visibleIds ?? [])
    .filter((id): id is FuturesColumnId => DEFAULT_FUTURES_COLUMN_IDS.includes(id as FuturesColumnId));
  return resolved.length > 0 ? resolved : [...DEFAULT_FUTURES_COLUMN_IDS];
}

/**
 * Futures are not quoted in dollars the way equities are: grains come back in
 * US cents (`USX`), FX contracts run to six decimals, and Treasury contracts
 * trade in fractions of a 32nd. Scale precision to the contract instead of
 * rendering everything as a currency amount.
 *
 * ponytail: rates render as decimals, not the 32nds tick notation traders
 * quote (108'17). Add a tick formatter if rates users ask for it.
 */
function priceDecimals(price: number, contract: FuturesContract): number {
  if (contract.sector === "rates") return 4;
  const magnitude = Math.abs(price);
  if (magnitude >= 10) return 2;
  if (magnitude >= 1) return 4;
  return 6;
}

/**
 * Trailing zeros are kept: a EUR contract at 1.1600 has to line up with the
 * 1.3544 pound contract beside it, and with its own "+0.0002" change.
 */
function formatContractPrice(quote: Quote, contract: FuturesContract): string {
  if (!Number.isFinite(quote.price)) return "—";
  const text = formatNumber(quote.price, priceDecimals(quote.price, contract));
  return quote.currency === "USX" ? `${text}c` : text;
}

/**
 * The session change is scaled to the contract's price, not to its own
 * magnitude, otherwise a four-tick move on an index future renders with six
 * decimals next to a price showing two.
 */
function formatContractChange(quote: Quote, contract: FuturesContract): string {
  if (!Number.isFinite(quote.change)) return "—";
  const decimals = Number.isFinite(quote.price) ? priceDecimals(quote.price, contract) : 2;
  const text = formatNumber(Math.abs(quote.change), decimals);
  return `${quote.change >= 0 ? "+" : "-"}${text}`;
}

export function renderFuturesCell(
  row: FuturesTableRow,
  column: FuturesColumn,
  rowState: { selected: boolean },
  quotes: BoardQuoteMap,
): DataTableCell {
  if (row.type === "header") return { text: "" };

  const { contract } = row;
  const state = quotes.get(contract.symbol);
  const quote = state?.quote;
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const dimmed = rowState.selected ? colors.selectedText : colors.textDim;

  switch (column.id) {
    case "status": {
      const dot = marketStatusDot(quote?.marketState);
      return { text: dot.char, color: rowState.selected ? colors.selectedText : dot.color };
    }
    case "code":
      return {
        text: contract.code,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "name":
      return { text: contract.name, color: selectedColor };
    case "price":
      if (state?.loading && !quote) return { text: "…", color: dimmed };
      if (state?.error || !quote) return { text: "—", color: dimmed };
      return { text: formatContractPrice(quote, contract), color: selectedColor };
    case "change":
      if (!quote || !Number.isFinite(quote.change)) return { text: "—", color: dimmed };
      return {
        text: formatContractChange(quote, contract),
        color: selectedColor ?? priceColor(quote.change),
      };
    case "changePercent":
      if (!quote || !Number.isFinite(quote.changePercent)) return { text: "—", color: dimmed };
      return {
        text: formatPercentRaw(quote.changePercent),
        color: selectedColor ?? priceColor(quote.changePercent),
      };
  }
}
