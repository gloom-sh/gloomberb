import { useEffect } from "react";
import type { AppConfig, BrokerInstanceConfig } from "../../../../types/config";
import type { BrokerAccount } from "../../../../types/trading";
import type { TickerRecord } from "../../../../types/ticker";
import {
  setTradeTicketDraft,
  updateTradeTicketState,
  type TradeTicketState,
} from "../../trading/state";
import { inferDraftAccountId } from "../utils";

export function useTradeTicketSync({
  availableAccounts,
  collectionId,
  config,
  isGatewayMode,
  lockedAccountId,
  selectedInstance,
  symbol,
  ticketState,
  ticker,
  tradeStateAccountId,
}: {
  availableAccounts: BrokerAccount[];
  collectionId: string | null | undefined;
  config: AppConfig;
  isGatewayMode: boolean;
  lockedAccountId?: string;
  selectedInstance?: BrokerInstanceConfig;
  symbol: string | null;
  ticketState: TradeTicketState;
  ticker: TickerRecord | null;
  tradeStateAccountId?: string;
}) {
  useEffect(() => {
    if (!symbol || !ticker || !selectedInstance) return;
    if (
      ticketState.brokerInstanceId !== selectedInstance.id
      || ticketState.brokerLabel !== selectedInstance.label
      || (lockedAccountId && ticketState.draft.accountId !== lockedAccountId)
    ) {
      updateTradeTicketState(symbol, ticker, (current) => ({
        ...current,
        brokerInstanceId: selectedInstance.id,
        brokerLabel: selectedInstance.label,
        draft: {
          ...current.draft,
          brokerInstanceId: selectedInstance.id,
          accountId: lockedAccountId ?? current.draft.accountId,
        },
      }));
    }
  }, [
    lockedAccountId,
    selectedInstance,
    symbol,
    ticketState.brokerInstanceId,
    ticketState.brokerLabel,
    ticketState.draft.accountId,
    ticker,
  ]);

  useEffect(() => {
    if (!symbol || !ticker || !isGatewayMode || availableAccounts.length === 0 || ticketState.draft.accountId || !selectedInstance) return;
    const inferred = inferDraftAccountId(
      config,
      collectionId ?? null,
      availableAccounts,
      selectedInstance.id,
      tradeStateAccountId,
    );
    if (inferred) {
      setTradeTicketDraft(symbol, { brokerInstanceId: selectedInstance.id, accountId: inferred }, ticker);
    }
  }, [
    availableAccounts,
    collectionId,
    config,
    isGatewayMode,
    selectedInstance,
    symbol,
    ticketState.draft.accountId,
    ticker,
    tradeStateAccountId,
  ]);
}
