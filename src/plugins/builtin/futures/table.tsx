import type { DataTableCell, DataTableColumn } from "../../../components";
import { marketStateColor, marketStateLabel } from "../../../market-data/market/status";
import { colors, priceColor } from "../../../theme/colors";
import type { Quote } from "../../../types/financials";
import { TextAttributes } from "../../../ui";
import { formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";
import { marketStatusDot, type BoardQuoteMap } from "../shared/use-quote-board";
import { formatQuoteTime } from "../world-indices/table";
import { tickDecimals, type FuturesContract } from "./contracts";
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
  { id: "volume", label: "Volume", description: "Contracts traded on the session." },
  { id: "prevClose", label: "Prev close", description: "Previous session close." },
  { id: "time", label: "Time", description: "Local time of the last quote." },
];

const DEFAULT_FUTURES_COLUMN_IDS = FUTURES_COLUMN_DEFS.map((column) => column.id);

/**
 * Extra columns only earn their width once the board is wide enough to keep a
 * readable contract name; a narrow pane drops them instead of clipping.
 */
const COLUMN_MIN_PANE_WIDTH: Partial<Record<FuturesColumnId, number>> = {
  volume: 92,
  prevClose: 104,
  time: 114,
};
const SESSION_TEXT_MIN_WIDTH = 100;

const COLUMN_WIDTHS: Record<Exclude<FuturesColumnId, "name">, number> = {
  status: 1,
  code: 5,
  price: 12,
  change: 10,
  changePercent: 9,
  volume: 9,
  prevClose: 12,
  // 5-char 24h time in an 8-wide column: the shared table's floating-pane width
  // accounting runs a few cells long, and the slack keeps the value intact.
  time: 8,
};

/** A colored dot needs a legend; the session word does not, so wide boards spell it out. */
export function usesSessionText(width: number): boolean {
  return width >= SESSION_TEXT_MIN_WIDTH;
}

function columnWidth(id: Exclude<FuturesColumnId, "name">, paneWidth: number): number {
  if (id === "status") return usesSessionText(paneWidth) ? 9 : 1;
  return COLUMN_WIDTHS[id];
}

export function createFuturesColumns(width: number, visibleIds?: readonly string[]): FuturesColumn[] {
  const ids = resolveFuturesColumnIds(visibleIds)
    .filter((id) => width >= (COLUMN_MIN_PANE_WIDTH[id] ?? 0));
  const fixed = ids
    .filter((id): id is Exclude<FuturesColumnId, "name"> => id !== "name")
    .reduce((total, id) => total + columnWidth(id, width), 0);
  // Leaves room for the pane border and scrollbar gutter; the name column grows
  // back into any slack because it is the flexible one.
  const nameWidth = Math.max(10, width - 6 - ids.length - fixed);

  return ids.map((id) => {
    const label = id === "status" && usesSessionText(width) ? "SESSION" : FUTURES_HEADER_LABELS[id];
    // The leftover width lands on the contract name rather than being spread
    // across the number columns, which is what left a dead zone after it.
    if (id === "name") return { id, label, width: nameWidth, align: "left", flexGrow: 1 };
    return {
      id,
      label,
      width: columnWidth(id, width),
      // TIME is left-aligned like the text columns: the shared table trims a few
      // cells off the right edge of a floating pane, and a right-aligned value
      // there would lose digits.
      align: id === "code" || id === "status" || id === "time" ? "left" : "right",
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
  volume: "VOL",
  prevClose: "PREV",
  time: "TIME",
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
 * The contract's own tick wins when the catalog knows it, so silver keeps its
 * $0.005 increments instead of being rounded into two decimals with gold. The
 * magnitude fallback only covers contracts without a declared tick.
 *
 * ponytail: rates render as decimals, not the 32nds tick notation traders
 * quote (108'17). Add a tick formatter if rates users ask for it.
 */
function priceDecimals(price: number, contract: FuturesContract): number {
  if (contract.tick) return tickDecimals(contract.tick);
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
  const decimals = contract.tick || Number.isFinite(quote.price)
    ? priceDecimals(quote.price, contract)
    : 2;
  const text = formatNumber(Math.abs(quote.change), decimals);
  return `${quote.change >= 0 ? "+" : "-"}${text}`;
}

export function renderFuturesCell(
  row: FuturesTableRow,
  column: FuturesColumn,
  rowState: { selected: boolean },
  quotes: BoardQuoteMap,
  options?: { sessionText?: boolean },
): DataTableCell {
  if (row.type === "header") return { text: "" };

  const { contract } = row;
  const state = quotes.get(contract.symbol);
  const quote = state?.quote;
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const dimmed = rowState.selected ? colors.selectedText : colors.textDim;
  // One row must not mix a loading marker with a no-data marker.
  const loadingCell = !quote && (state?.loading ?? true);

  switch (column.id) {
    case "status": {
      if (loadingCell) return { text: "", color: dimmed };
      if (options?.sessionText) {
        const marketState = quote?.marketState;
        return {
          text: marketState ? marketStateLabel(marketState) : "—",
          color: rowState.selected
            ? colors.selectedText
            : marketState ? marketStateColor(marketState) : colors.textDim,
        };
      }
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
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote) return { text: "—", color: dimmed };
      // A retained quote still beats a dash; dim it so stale is visible.
      return {
        text: formatContractPrice(quote, contract),
        color: state?.stale ? dimmed : selectedColor,
      };
    case "change":
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote || !Number.isFinite(quote.change)) return { text: "—", color: dimmed };
      return {
        text: formatContractChange(quote, contract),
        color: selectedColor ?? priceColor(quote.change),
      };
    case "changePercent":
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote || !Number.isFinite(quote.changePercent)) return { text: "—", color: dimmed };
      return {
        text: formatPercentRaw(quote.changePercent),
        color: selectedColor ?? priceColor(quote.changePercent),
      };
    case "volume":
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote || quote.volume == null || !Number.isFinite(quote.volume)) {
        return { text: "—", color: dimmed };
      }
      return { text: formatCompact(quote.volume), color: selectedColor ?? colors.textDim };
    case "prevClose":
      if (loadingCell) return { text: "…", color: dimmed };
      if (!quote || quote.previousClose == null || !Number.isFinite(quote.previousClose)) {
        return { text: "—", color: dimmed };
      }
      return {
        text: formatContractPrice({ ...quote, price: quote.previousClose }, contract),
        color: selectedColor ?? colors.textDim,
      };
    case "time":
      if (loadingCell) return { text: "…", color: dimmed };
      return { text: formatQuoteTime(quote?.lastUpdated), color: dimmed };
  }
}
