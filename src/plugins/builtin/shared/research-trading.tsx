import { createContext, useContext } from "react";
import { Button } from "../../../components";
import type { CompositeChartLevel } from "../../../components/chart/composite/levels";
import { useShortcut } from "../../../react/input";
import { Box } from "../../../ui";
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
  docked: boolean;
  visible: boolean;
  open(side: "BUY" | "SELL"): void;
  close(): void;
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

/** Chart-header actions, absent outside a trading-capable Research pane. */
export function ResearchTradeActions({ focused }: { focused: boolean }) {
  const trade = useResearchTrading();
  const dialog = useDialogState((state) => state.isOpen);
  useShortcut((event) => {
    if (!trade || event.defaultPrevented || event.propagationStopped || event.targetEditable || event.ctrl || event.alt || event.meta || event.shift || event.super || event.repeat) return;
    if (event.name !== "b" && event.name !== "s") return;
    event.preventDefault(); event.stopPropagation(); trade.open(event.name === "b" ? "BUY" : "SELL");
  }, { enabled: focused && !!trade && !dialog, phase: "before", scope: "research:trade-open" });
  if (!trade) return null;
  return <Box flexDirection="row" gap={1} flexShrink={0}>
    <Button label="Buy" variant="primary" tone="positive" width={7} onPress={() => trade.open("BUY")} disabled={trade.busy} stopPropagation />
    <Button label="Sell" variant="primary" tone="negative" width={7} onPress={() => trade.open("SELL")} disabled={trade.busy} stopPropagation />
  </Box>;
}
