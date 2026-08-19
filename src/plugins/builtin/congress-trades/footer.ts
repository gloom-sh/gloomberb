import { usePaneFooter } from "../../../components";
import { formatTimeAgo } from "../../../utils/format";
import type {
  CloudCongressHousePayload,
  CloudCongressTradePayload,
} from "../../../api-client";
import {
  CONGRESS_TRADES_PANE_ID,
  type CongressTab,
  type DetailMode,
  type LoadStatus,
} from "./model";

export function useCongressTradesFooter({
  activeTab,
  detailMode,
  detailTrade,
  error,
  openSelectedTicker,
  openSelectedTradeMember,
  openSelectedTradeSource,
  payload,
  selectedTrade,
  status,
}: {
  activeTab: CongressTab;
  detailMode: DetailMode;
  detailTrade: CloudCongressTradePayload | null;
  error: string | null;
  openSelectedTicker: () => void;
  openSelectedTradeMember: () => void;
  openSelectedTradeSource: () => void;
  payload: CloudCongressHousePayload | null;
  selectedTrade: CloudCongressTradePayload | null;
  status: LoadStatus;
}) {
  usePaneFooter(CONGRESS_TRADES_PANE_ID, () => ({
    info: [
      ...(payload ? [
        { id: "asof", parts: [{ text: `updated ${formatTimeAgo(payload.asOf)}`, tone: "muted" as const }] },
      ] : []),
      ...(status === "loading" ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
    hints: detailMode?.kind !== "member" && activeTab === "trades" && (detailTrade ?? selectedTrade)
      ? [
          { id: "member", key: "m", label: "ember", onPress: openSelectedTradeMember },
          { id: "ticker", key: "t", label: "icker", onPress: openSelectedTicker, disabled: !(detailTrade?.ticker ?? selectedTrade?.ticker) },
          { id: "open", key: "o", label: "pen", onPress: openSelectedTradeSource, disabled: !(detailTrade ?? selectedTrade)?.sourceUrl },
        ]
      : [],
  }), [
    activeTab,
    detailMode,
    detailTrade,
    error,
    openSelectedTicker,
    openSelectedTradeMember,
    openSelectedTradeSource,
    payload,
    selectedTrade,
    status,
  ]);
}
