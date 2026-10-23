import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CompositeChart,
  DataTableView,
  PaneStatusBody,
  StatGrid,
  type DataTableColumn,
  type PaneHint,
  type StatItem,
} from "../../../components";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { staticSeries } from "../../../components/chart/static/series";
import { isAccessDenied } from "../../../api-client/errors";
import type { MnaDeal, MnaDealEvent } from "../../../api-client/mna";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useAsyncResource, usePluginPaneState, useShortcut } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PricePoint } from "../../../types/financials";
import type { AssetDataProvider } from "../../../types/data-provider";
import type { TimeRange } from "../../../time-series/range";
import { Box, useRendererHost } from "../../../ui";
import { useAssetData, usePluginTickerActions } from "../../runtime";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { useQuoteBoard } from "../shared/use-quote-board";
import { cachedMnaDeal, loadMnaDeal } from "./client";
import {
  dealSpread,
  electionLeg,
  formatDealValue,
  formatExpectedClose,
  formatListDate,
  formatPercentShort,
  formatPerShare,
  formatPrice,
  inQuoteCurrency,
  isElection,
  MISSING,
  offerSeries,
  stageLabel,
  termsLabel,
} from "./model";

/** "ACV Auctions Inc. ← Copart, Inc.": the target, then who is buying it. */
export function mnaDealTitle(deal: MnaDeal): string {
  return deal.acquirer ? `${deal.target.name} ← ${deal.acquirer.name}` : deal.target.name;
}

const TIMELINE_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "DATE", width: 8, align: "left" },
  { id: "title", label: "EVENT", width: 30, align: "left", flexGrow: 1 },
  { id: "source", label: "SOURCE", width: 14, align: "left" },
];

const NO_SYMBOLS: string[] = [];
const NO_EVENTS: MnaDealEvent[] = [];

/** History starts this long before the announcement, so the jump shows. */
const LEAD_DAYS = 45;

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const dayOf = (point: PricePoint) => point.date.toISOString().slice(0, 10);

async function dailyCloses(provider: AssetDataProvider, symbol: string, from: string): Promise<PricePoint[]> {
  const ageDays = (Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  const range: TimeRange = ageDays < 170 ? "6M" : ageDays < 350 ? "1Y" : "5Y";
  const points = provider.getPriceHistoryForResolutionWithMetadata
    ? (await provider.getPriceHistoryForResolutionWithMetadata(symbol, "", range, "1d")).points
    : provider.getPriceHistoryForResolution
      ? await provider.getPriceHistoryForResolution(symbol, "", range, "1d")
      : await provider.getPriceHistory(symbol, "", range);
  return points.filter((point) => Number.isFinite(point.close) && dayOf(point) >= from);
}

/**
 * The target's daily closes since before the announcement, and the listing a
 * ratio pays in when the offer line needs it (an election priced at its cash
 * leg does not).
 */
function useDealHistory(deal: MnaDeal | null, leg: "cash" | "stock" | null) {
  const provider = useAssetData();
  const target = deal?.target.symbol ?? null;
  const ratio = deal?.terms.exchangeRatio != null && leg !== "cash" ? deal.terms.ratioSymbol : null;
  const from = deal ? shiftDay(deal.announced, -LEAD_DAYS) : null;
  const [history, setHistory] = useState<{ key: string; target: PricePoint[]; ratio: PricePoint[] } | null>(null);
  const key = `${target}:${ratio}:${from}`;
  useEffect(() => {
    if (!provider || !target || !from) return;
    let cancelled = false;
    void Promise.all([
      dailyCloses(provider, target, from),
      ratio ? dailyCloses(provider, ratio, from) : Promise.resolve([]),
    ]).then(([targetPoints, ratioPoints]) => {
      if (!cancelled) setHistory({ key, target: targetPoints, ratio: ratioPoints });
    }).catch(() => {
      if (!cancelled) setHistory({ key, target: [], ratio: [] });
    });
    return () => { cancelled = true; };
  }, [from, key, provider, ratio, target]);
  return history?.key === key ? history : null;
}

export function MnaDealDetail({ id, seed, focused, width, height }: {
  id: string;
  /** The list's copy, drawn while the full deal loads. */
  seed: MnaDeal | null;
  focused: boolean;
  width: number;
  height: number;
}) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const pro = usePlanAccess().hasProAccess;
  const session = useResearchCloudSession();
  const { pinTicker } = usePluginTickerActions();
  const loader = useCallback(
    (force: boolean) => loadMnaDeal(id, pro, force),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, pro, session.requestKey],
  );
  const resource = useAsyncResource(loader, { initialData: () => cachedMnaDeal(id, pro), clearOnError: isAccessDenied });
  const payload = resource.data?.payload ?? null;
  const deal = payload?.deal ?? seed;
  const events = payload?.events ?? NO_EVENTS;
  const [selectedEvent, setSelectedEvent] = usePluginPaneState<string | null>(`mna:event:${id}`, null);

  const symbols = useMemo(
    () => [deal?.target.symbol, deal?.terms.exchangeRatio != null ? deal.terms.ratioSymbol : null]
      .filter((value): value is string => !!value),
    [deal],
  );
  const { quotes } = useQuoteBoard(deal?.status === "pending" ? symbols : NO_SYMBOLS);
  const targetQuote = deal?.target.symbol ? quotes.get(deal.target.symbol)?.quote ?? null : null;
  const ratioQuote = deal?.terms.ratioSymbol ? quotes.get(deal.terms.ratioSymbol)?.quote ?? null : null;
  const spread = deal ? dealSpread(deal, targetQuote, ratioQuote) : null;
  // The leg an election's Offer, premium and offer line are priced at; null for other terms.
  const leg = deal && isElection(deal.terms) ? electionLeg(deal.terms, targetQuote) : null;
  const history = useDealHistory(deal, leg);

  const unaffected = useMemo(() => {
    if (!deal || !history) return null;
    const before = history.target.filter((point) => dayOf(point) < deal.announced);
    return before.at(-1) ?? null;
  }, [deal, history]);

  const stats = useMemo<StatItem[]>(() => {
    if (!deal) return [];
    const items: StatItem[] = [];
    const terms = termsLabel(deal.terms);
    if (spread) {
      const stock = deal.terms.exchangeRatio != null;
      const currency = targetQuote?.currency ?? null;
      items.push({ id: "offer", label: "Offer", value: formatPerShare(spread.offer, currency, 2), detail: stock ? terms : undefined });
      items.push({
        id: "spread",
        label: "Spread",
        value: formatPercentShort(spread.spread),
        detail: formatPerShare(Math.abs(spread.offer - spread.price), currency, 2),
        tone: spread.spread < 0 ? "warning" : undefined,
      });
      if (spread.annualized != null) items.push({ id: "ann", label: "Ann.", value: formatPercentShort(spread.annualized) });
      if (unaffected && unaffected.close > 0 && (deal.terms.exchangeRatio == null || leg === "cash")) {
        items.push({
          id: "premium",
          label: "Premium",
          value: formatPercentShort(spread.offer / unaffected.close - 1),
          detail: `vs ${formatPrice(unaffected.close)} ${formatListDate(dayOf(unaffected))}`,
        });
      }
    } else {
      items.push({ id: "stage", label: "Status", value: stageLabel(deal) });
      if (terms !== MISSING) {
        items.push({ id: "terms", label: "Terms", value: terms });
      } else if (deal.terms.cashPerShare != null) {
        items.push({ id: "terms", label: "Terms", value: formatPerShare(deal.terms.cashPerShare, deal.terms.currency) });
      }
    }
    items.push({ id: "value", label: "Value", value: formatDealValue(deal.value, deal.valueCurrency) });
    if (deal.status === "completed" || deal.status === "terminated") {
      items.push({ id: "closed", label: deal.status === "completed" ? "Closed" : "Ended", value: deal.closed ? formatListDate(deal.closed) : MISSING });
    } else {
      items.push({ id: "close", label: "Close", value: formatExpectedClose(deal.expectedClose) });
      if (spread) items.push({ id: "stage", label: "Stage", value: stageLabel(deal) });
    }
    return items;
  }, [deal, leg, spread, targetQuote?.currency, unaffected]);

  const series = useMemo(() => {
    if (!deal?.target.symbol || !history || history.target.length < 3) return [];
    const days = history.target.map(dayOf);
    const offer = leg === "stock"
      ? offerSeries(deal, history.ratio, days, leg, (close) => inQuoteCurrency(close, ratioQuote?.currency ?? null, targetQuote?.currency))
      : offerSeries(deal, history.ratio, days, leg);
    const priced = [
      staticSeries(
        history.target.map((point) => ({ date: point.date, observedAt: point.date, value: point.close })),
        { id: "target", label: deal.target.symbol, color: colors.text, calendarSpaced: true },
      ),
    ];
    if (offer.length >= 2) {
      priced.push(staticSeries(
        offer.map((row) => {
          const date = new Date(`${row.day}T00:00:00Z`);
          return { date, observedAt: date, value: row.value };
        }),
        { id: "offer", label: "Offer", color: colors.positive, calendarSpaced: true },
      ));
    }
    return priced;
  }, [colors.positive, colors.text, deal, history, leg, ratioQuote?.currency, targetQuote?.currency]);

  const selected = events.find((event) => event.id === selectedEvent) ?? events[0] ?? null;
  const openSource = useCallback((event: MnaDealEvent | null) => {
    if (event?.url) void rendererHost.openExternal(event.url);
  }, [rendererHost]);
  const openTarget = useCallback(() => {
    if (deal?.target.symbol) pinTicker(deal.target.symbol, { floating: true });
  }, [deal?.target.symbol, pinTicker]);
  useShortcut((event) => {
    if (!focused || event.targetEditable || event.ctrl || event.meta || event.alt || event.super) return;
    if (event.name === "o" && selected?.url) { event.preventDefault(); openSource(selected); }
    if (event.name === "t" && deal?.target.symbol) { event.preventDefault(); openTarget(); }
  });
  const hints = useMemo<PaneHint[]>(() => [
    ...(selected?.url ? [{ id: "mna-open", key: "o", label: "pen source", onPress: () => openSource(selected) }] : []),
    ...(deal?.target.symbol ? [{ id: "mna-detail-target", key: "t", label: "arget", onPress: openTarget }] : []),
  ], [deal?.target.symbol, openSource, openTarget, selected]);
  usePaneStatusFooter({
    registrationId: "mna:detail",
    loading: resource.loading && !!payload,
    error: payload ? resource.error : null,
    hints,
  });

  const grid = <StatGrid items={stats} width={width} />;
  const gridRows = Math.max(1, Math.ceil(stats.length / Math.max(1, Math.floor(width / 18))));
  const bodyHeight = Math.max(3, height - gridRows);
  const chartHeight = series.length > 0 && bodyHeight >= 14 ? Math.max(6, Math.floor(bodyHeight * 0.45)) : 0;

  return (
    <PaneStatusBody loading={resource.loading && !payload && !seed} error={!payload && !seed ? resource.error : null} subject="deal">
      {deal ? (
        <Box width={width} height={height} flexDirection="column">
          {grid}
          {chartHeight > 0 ? (
            <CompositeChart
              series={series}
              panels={[{ id: "main" }]}
              width={width}
              height={chartHeight}
              focused={false}
              showLegend
              showTimeAxis
              navigable={false}
              formatValue={(value) => formatPrice(value)}
              remoteKind="mna-deal"
            />
          ) : null}
          <DataTableView<MnaDealEvent>
            columns={TIMELINE_COLUMNS}
            items={events}
            focused={focused}
            rootWidth={width}
            rootHeight={Math.max(3, bodyHeight - chartHeight)}
            selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (event) => event.id, onChange: setSelectedEvent }}
            getItemKey={(event) => event.id}
            onActivate={(event) => openSource(event)}
            sortColumnId={null}
            sortDirection="desc"
            renderCell={(event, column, _index, state) => {
              const base = state.selected ? colors.selectedText : colors.text;
              const muted = state.selected ? colors.selectedText : colors.textMuted;
              if (column.id === "date") return { text: formatListDate(event.date), color: muted };
              if (column.id === "source") return { text: event.source, color: muted };
              return { text: event.title, color: base };
            }}
            emptyStateTitle={resource.loading ? "Loading the timeline..." : "No events yet."}
          />
        </Box>
      ) : null}
    </PaneStatusBody>
  );
}
