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
}
export interface ResearchTrading extends ResearchTradeProjection {
  symbol: string;
  /** A trading-capable broker profile is enabled, so b and s lead somewhere. */
  available?: boolean;
  docked: boolean;
  visible: boolean;
  /** The docked ticket holds focus; the chart beside it only sees keys the ticket leaves. */
  ticketFocused?: boolean;
  open(side: "BUY" | "SELL"): void;
  close(): void;
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
  return !contract.exchange || !exchange || canonicalExchange(contract.exchange) === exchange;
}

/** Trading actions stay in the pane menu and keyboard, not the range toolbar. */
export function ResearchTradeActions({ focused }: { focused: boolean }) {
  const trade = useResearchTrading();
  const dialog = useDialogState((state) => state.isOpen);
  useShortcut((event) => {
    if (!trade || trade.ticketFocused || event.defaultPrevented || event.propagationStopped || event.targetEditable || event.ctrl || event.alt || event.meta || event.shift || event.super || event.repeat) return;
    if (event.name !== "b" && event.name !== "s") return;
    event.preventDefault(); event.stopPropagation(); trade.open(event.name === "b" ? "BUY" : "SELL");
  }, { enabled: focused && !!trade && !dialog, phase: "before", scope: "research:trade-open" });
  usePaneMenuItems("research:trade-open", () => trade ? [
    { id: "trade-buy", label: "Buy", accelerator: "b", enabled: !trade.busy, onSelect: () => trade.open("BUY") },
    { id: "trade-sell", label: "Sell", accelerator: "s", enabled: !trade.busy, onSelect: () => trade.open("SELL") },
  ] : null, [trade]);
  return null;
}
