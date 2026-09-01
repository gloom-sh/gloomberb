import { useShortcut } from "../../../../react/input";
import type { TickerRecord } from "../../../../types/ticker";
import type { TradeTicketState } from "../../trading/state";
import type { TradeTabActions } from "./actions";

export function useTradeTabShortcuts({
  actions,
  enterInteractive,
  exitInteractive,
  focused,
  interactive,
  showLimit,
  showStop,
  symbol,
  ticketState,
  ticker,
}: {
  actions: TradeTabActions;
  enterInteractive: () => void;
  exitInteractive: () => void;
  focused: boolean;
  interactive: boolean;
  showLimit: boolean;
  showStop: boolean;
  symbol: string | null;
  ticketState: TradeTicketState;
  ticker: TickerRecord | null;
}) {
  useShortcut((event) => {
    if (!focused || !symbol || !ticker) return;

    const isEnter = event.name === "enter" || event.name === "return";
    if (event.name === "escape" && interactive) {
      event.stopPropagation?.();
      exitInteractive();
      return;
    }
    if (isEnter && !interactive) {
      event.stopPropagation?.();
      enterInteractive();
      return;
    }
    if (!interactive) return;
    event.stopPropagation?.();

    if (ticketState.busy) return;

    switch (event.name) {
      case "r":
        actions.refresh().catch(() => {});
        break;
      case "i":
        actions.chooseBrokerInstance().catch(() => {});
        break;
      case "s":
      case "/":
        actions.chooseInstrument().catch(() => {});
        break;
      case "a":
        actions.chooseAccount().catch(() => {});
        break;
      case "b":
        actions.buyOrder();
        break;
      case "v":
        actions.sellOrder();
        break;
      case "q":
        actions.editQuantity().catch(() => {});
        break;
      case "t":
        actions.editOrderType().catch(() => {});
        break;
      case "l":
        if (showLimit) actions.editLimitPrice().catch(() => {});
        break;
      case "x":
        if (showStop) actions.editStopPrice().catch(() => {});
        break;
      case "p":
        actions.previewOrder().catch(() => {});
        break;
      case "return":
      case "enter":
        actions.submitOrder().catch(() => {});
        break;
    }
  });
}
