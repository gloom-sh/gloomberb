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
  loadPreviousYear,
  loadMore,
  loadingMore,
  registrationId = CONGRESS_TRADES_PANE_ID,
  openSelectedTicker,
  openSelectedTradeMember,
  openSelectedTradeSource,
  payload,
  previousYear,
  selectedTrade,
  status,
}: {
  activeTab: CongressTab;
  detailMode: DetailMode;
  detailTrade: CloudCongressTradePayload | null;
  error: string | null;
  loadPreviousYear: (() => void) | null;
  loadMore: (() => void) | null;
  loadingMore: boolean;
  registrationId?: string;
  openSelectedTicker: () => void;
  openSelectedTradeMember: () => void;
  openSelectedTradeSource: () => void;
  payload: CloudCongressHousePayload | null;
  previousYear: number | null;
  selectedTrade: CloudCongressTradePayload | null;
  status: LoadStatus;
}) {
  usePaneFooter(registrationId, () => detailMode?.kind === "member" || detailMode?.kind === "ticker" ? {} : ({
    info: [
      ...(payload ? [
        { id: "asof", parts: [{ text: `updated ${formatTimeAgo(payload.asOf)}`, tone: "muted" as const }] },
      ] : []),
      ...(status === "loading" ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
    hints: [
      ...(!detailMode && loadMore ? [{ id: "next-filings", key: "n", label: "ext filings", onPress: loadMore, disabled: loadingMore }] : []),
      ...(activeTab === "trades" && (detailTrade ?? selectedTrade)
        ? [
            { id: "member", key: "m", label: "ember", onPress: openSelectedTradeMember },
            { id: "ticker", key: "t", label: "icker", onPress: openSelectedTicker, disabled: !(detailTrade?.ticker ?? selectedTrade?.ticker) },
            { id: "open", key: "o", label: "pen", onPress: openSelectedTradeSource, disabled: !(detailTrade ?? selectedTrade)?.sourceUrl },
          ]
        : []),
      ...(activeTab === "tickers" ? [{ id: "ticker", key: "t", label: "icker", onPress: openSelectedTicker }] : []),
      ...(!detailMode && loadPreviousYear && previousYear
        ? [{ id: "prev-year", key: "p", label: `rev year ${previousYear}`, onPress: loadPreviousYear }]
        : []),
    ],
  }), [
    activeTab,
    detailMode,
    detailTrade,
    error,
    loadPreviousYear,
    loadMore,
    loadingMore,
    openSelectedTicker,
    openSelectedTradeMember,
    openSelectedTradeSource,
    payload,
    previousYear,
    selectedTrade,
    status,
  ]);
}
