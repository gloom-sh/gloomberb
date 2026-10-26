import { createContext, useContext, type ReactNode } from "react";
import { usePaneMenuItems } from "../../../components";
import type { CompositeChartLevel } from "../../../components/chart/composite/levels";
import { useShortcut } from "../../../react/input";
import { useDialogState } from "../../../ui/dialog";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { BrokerContractRef } from "../../../types/instrument";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { scopedBrokerContractIdentityKey } from "../../../utils/instrument-identity";

export interface ResearchTradeProjection {
  levels: readonly CompositeChartLevel[];
  contract?: BrokerContractRef;
  mode?: "simulation" | "live" | "unknown";
  busy?: boolean;
  /**
   * Moves one of `levels` to a price: a draft's price changes in the ticket, and a working order's change
   * opens there for review. Nothing reaches the broker before the ticket's review and confirm.
   */
  moveLevel?(id: string, value: number): void;
  /** The ticket prices a price picked on the chart can set now; the first is the one picked without a choice. */
  priceFields?: readonly ResearchTradePriceField[];
  /** Sets a ticket price to one picked on the chart. */
  setPrice?(field: string, value: number): void;
}
interface ResearchTradePriceField {
  field: string;
  /** As the pick's hint says it: "limit", "stop", "take profit", "stop loss". */
  label: string;
}
export interface ResearchTrading extends ResearchTradeProjection {
  symbol: string;
  /** A trading-capable broker profile is enabled, so t leads somewhere. */
  available?: boolean;
  docked: boolean;
  visible: boolean;
  /** The docked ticket holds focus; the chart beside it only sees keys the ticket leaves. */
  ticketFocused?: boolean;
  /** Opens the ticket; without a side it keeps its draft, and Buy or Sell is chosen in it. */
  open(side?: "BUY" | "SELL"): void;
  close(): void;
  /** A press on the chart takes the keyboard back from the ticket, even a field typing in it. */
  focusChart?(): void;
  /** The ticket price the chart beside it is picking, while it is. */
  picking?: ResearchTradePriceField;
  /** Picks a ticket price on the chart beside it, the first of `priceFields` without a field. */
  pickPrice?(field?: string): void;
  /** Hands the picked price to the ticket, which takes the keyboard back. */
  finishPick?(value: number): void;
  cancelPick?(): void;
  /** This ticker's working orders and latest fills, for Overview; absent without a trading profile. */
  orders?(width: number): ReactNode;
  publish(projection: ResearchTradeProjection): void;
}
const Context = createContext<ResearchTrading | null>(null);
export const ResearchTradingProvider = Context.Provider;
export const useResearchTrading = () => useContext(Context);

/** Never put an option premium or another venue's price on the underlying chart. */
export function researchTradeMatches(trade: ResearchTradeProjection | null, listing: InstrumentRef | null): boolean {
  const contract = trade?.contract;
  if (!contract || !listing) return false;
  if (listing.instrument) return scopedBrokerContractIdentityKey(contract) === scopedBrokerContractIdentityKey(listing.instrument);
  if (contract.secType && !["STK", "ETF"].includes(contract.secType)) return false;
  if (contract.symbol.toUpperCase() !== parsePublicTickerKey(listing.symbol).symbol.toUpperCase()) return false;
  const exchange = canonicalExchange(listing.exchange ?? parsePublicTickerKey(listing.symbol).exchange);
  // SMART is a route, not a listing: a share a broker routes is on any of its venues.
  const venue = [contract.exchange, contract.primaryExchange].map(canonicalExchange).find((name) => name && name !== "SMART");
  return !venue || !exchange || venue === exchange;
}

/** Trade stays in the pane menu and keyboard, not the range toolbar: one key, and the ticket picks the side. */
export function ResearchTradeActions({ focused }: { focused: boolean }) {
  const trade = useResearchTrading();
  const dialog = useDialogState((state) => state.isOpen);
  useShortcut((event) => {
    if (!trade || trade.ticketFocused || event.defaultPrevented || event.propagationStopped || event.targetEditable || event.ctrl || event.alt || event.meta || event.shift || event.super || event.repeat) return;
    if (event.name !== "t") return;
    event.preventDefault(); event.stopPropagation(); trade.open();
  }, { enabled: focused && !!trade && !dialog, phase: "before", scope: "research:trade-open" });
  usePaneMenuItems("research:trade-open", () => trade ? [
    { id: "trade-open", label: "Trade", accelerator: "t", enabled: !trade.busy, onSelect: () => trade.open() },
  ] : null, [trade]);
  return null;
}
