import { usePaneFooter } from "../../../../components";
import type { TickerRecord } from "../../../../types/ticker";
import type { TradeTicketState } from "../../trading/state";
import type { TradeTabActions } from "./actions";

/**
 * Ticket status (next step, capture state, last message) lives in the tab header,
 * which shows it untruncated and interactively, so the footer only carries actions.
 */
export function useTradeTabFooter({
  actions,
  canEnterOrder,
  showLimit,
  showStop,
  symbol,
  ticketState,
  ticker,
}: {
  actions: TradeTabActions;
  /** False until a broker profile and account are picked, so order fields cannot be edited yet. */
  canEnterOrder: boolean;
  showLimit: boolean;
  showStop: boolean;
  symbol: string | null;
  ticketState: TradeTicketState;
  ticker: TickerRecord | null;
}) {
  usePaneFooter("ibkr-trade", () => ({
    hints: [
      ...(!ticketState.busy ? [
        { id: "profile", key: "i", label: "profile", onPress: () => actions.chooseBrokerInstance().catch(() => {}) },
        { id: "account", key: "a", label: "ccount", onPress: () => actions.chooseAccount().catch(() => {}) },
      ] : []),
      ...(!ticketState.busy && canEnterOrder && symbol && ticker ? [
        { id: "side", key: "b/v", label: "side", onPress: actions.toggleSide },
        { id: "quantity", key: "q", label: "ty", onPress: () => actions.editQuantity().catch(() => {}) },
        { id: "type", key: "t", label: "ype", onPress: () => actions.editOrderType().catch(() => {}) },
        ...(showLimit ? [{ id: "limit", key: "l", label: "imit", onPress: () => actions.editLimitPrice().catch(() => {}) }] : []),
        ...(showStop ? [{ id: "stop", key: "x", label: "stop", onPress: () => actions.editStopPrice().catch(() => {}) }] : []),
        { id: "preview", key: "p", label: "review", onPress: () => actions.previewOrder().catch(() => {}) },
      ] : []),
    ],
  }), [
    actions,
    canEnterOrder,
    showLimit,
    showStop,
    symbol,
    ticketState.busy,
    ticketState.draft,
    ticker,
  ]);
}
