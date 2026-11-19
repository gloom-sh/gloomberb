import { usePaneFooter, type PaneFooterSegment } from "../../../components";
import { timestampFooterSegment } from "../../../components/layout/pane/footer/freshness";
import { formatShortDate } from "../../../utils/datetime-format";
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

export function latestCongressFiling(trades: readonly Pick<CloudCongressTradePayload, "filingDate">[]): string | null {
  return trades.reduce<string | null>((latest, { filingDate }) => !latest || filingDate > latest ? filingDate : latest, null);
}

export function congressFreshnessFooter(
  payload: Pick<CloudCongressHousePayload, "asOf" | "fetchedAt"> | null,
  latestFiling: string | null,
): PaneFooterSegment[] {
  const fetched = timestampFooterSegment("fetched-at", "fetched", payload?.fetchedAt ?? payload?.asOf);
  return [
    ...(latestFiling ? [{ id: "latest-filing", parts: [{ text: `latest filing ${formatShortDate(latestFiling, { utc: true })}`, tone: "muted" as const }] }] : []),
    ...(fetched ? [fetched] : []),
  ];
}

export function useCongressTradesFooter({
  activeTab,
  detailMode,
  detailTrade,
  error,
  latestFiling,
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
  latestFiling: string | null;
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
      ...congressFreshnessFooter(payload, latestFiling),
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
    latestFiling,
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
