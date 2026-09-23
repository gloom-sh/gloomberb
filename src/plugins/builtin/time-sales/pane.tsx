import { useMemo, useState } from "react";
import { Box } from "../../../ui";
import { usePaneSettingValue, useShortcut } from "../../../public/react";
import { DataTableStackView, KeyValueRow, PaneStatusBody, StatGrid, Tabs, usePaneFooter, usePaneHeaderTabs, usePaneNoticeFooter, usePaneStatusFooter, usePaneTicker, type DataTableColumn } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import type { TapeQuote, TapeSnapshot, TapeTrade } from "../../../api-client/tape";
import { canonicalExchange } from "../../../utils/exchanges";
import { listingIdentity } from "../shared/ticker-request";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { newestFirst, quoteKey, quoteSpread, tapeClockMs, tapePrice, tapePriceDigits, tapeQuantity, tapeStatistics, tapeTime, tapeTimeSeconds, tradeKey } from "./model";
import { useTape } from "./use-tape";

const TABS = [{ value: "trades", label: "Trades" }, { value: "quotes", label: "NBBO" }];
const TRADES: DataTableColumn[] = [
  { id: "time", label: "TIME UTC", width: 13, align: "left" },
  { id: "price", label: "PRICE", width: 12, align: "right" },
  { id: "size", label: "SHARES", width: 12, align: "right" },
  { id: "venue", label: "VENUE", width: 6, align: "left" },
  { id: "conditions", label: "CONDITIONS", width: 12, align: "left", flexGrow: 1 },
  { id: "tape", label: "TAPE", width: 4, align: "left" },
];
const QUOTES: DataTableColumn[] = [
  { id: "time", label: "TIME UTC", width: 13, align: "left" },
  { id: "bid", label: "BID", width: 11, align: "right" },
  { id: "bidSize", label: "LOTS", width: 8, align: "right" },
  { id: "bidExchange", label: "VENUE", width: 6, align: "left" },
  { id: "ask", label: "ASK", width: 11, align: "right" },
  { id: "askSize", label: "LOTS", width: 8, align: "right" },
  { id: "askExchange", label: "VENUE", width: 6, align: "left" },
  { id: "spread", label: "SPREAD BP", width: 10, align: "right" },
];
const rank = (value: number | null) => value == null ? "pctl --" : `${value.toFixed(0)} pctl`;
type TapeRow = { id: string; trade?: TapeTrade; quote?: TapeQuote };

export function TimeSalesPane(props: PaneProps) {
  const { symbol, ticker } = usePaneTicker();
  const session = useResearchCloudSession();
  const identity = listingIdentity(symbol, ticker?.metadata.exchange ?? "");
  const exchange = canonicalExchange(identity?.exchange ?? "");
  if (!identity) return <PaneStatusBody empty emptyTitle="Select a US equity." subject="time and sales" />;
  return <TimeSalesView key={`${identity.symbol}:${exchange}:${session.requestKey}`} {...props} symbol={identity.symbol} exchange={exchange} />;
}
function TimeSalesView({ width, height, focused, symbol, exchange }: PaneProps & { symbol: string; exchange: string }) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const [refresh, setRefresh] = useState(0);
  const resource = useTape(symbol, exchange, session.requestKey, refresh);
  const [tab, setTab] = usePaneSettingValue("tab", "trades");
  const [paused, setPaused] = useState<{ data: TapeSnapshot; epoch: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailState, setDetail] = useState<{ row: TapeRow; epoch: number } | null>(null);
  const detail = detailState?.epoch === resource.epoch ? detailState.row : null;
  const frozen = paused?.epoch === resource.epoch ? paused.data : null;
  // A session change clears live and frozen copies before a different tier arrives.
  const data = resource.data ? frozen?.access === resource.data.access ? frozen : resource.data : null;
  const stats = useMemo(() => data ? tapeStatistics(data) : null, [data]);
  const rows: TapeRow[] = useMemo(() => !data ? [] : tab === "quotes"
    ? newestFirst(data.quotes).map((quote) => ({ id: quoteKey(quote), quote }))
    : newestFirst(data.trades).map((trade) => ({ id: tradeKey(trade), trade })), [data, tab]);
  const spreads = useMemo(() => {
    const quotes = data?.quotes ?? [];
    const bps = quotes.map((quote) => quoteSpread(quote)).filter((spread) => spread.state === "normal" && spread.bps != null).map((spread) => spread.bps!).sort((a, b) => a - b);
    return {
      median: bps.length ? bps[Math.floor((bps.length - 1) / 2)]! : null,
      widest: bps.length ? bps[bps.length - 1]! : null,
      abnormal: quotes.filter((quote) => { const state = quoteSpread(quote).state; return state === "locked" || state === "crossed"; }).length,
    };
  }, [data]);
  const tradeDigits = useMemo(() => tapePriceDigits(data?.trades.map((trade) => trade.price) ?? []), [data]);
  const quoteDigits = useMemo(() => tapePriceDigits(data?.quotes.flatMap((quote) => [quote.bid, quote.ask]) ?? []), [data]);
  const freeze = () => { setPaused(frozen || !resource.data ? null : { data: resource.data, epoch: resource.epoch }); setDetail(null); };
  const reload = () => { setPaused(null); setDetail(null); setRefresh((value) => value + 1); };
  useShortcut((event) => {
    if (!focused || event.targetEditable || event.ctrl || event.meta) return;
    if (event.name === "space") { event.preventDefault(); freeze(); }
    if (event.name === "r") { event.preventDefault(); reload(); }
  });
  usePaneFooter("time-sales:actions", () => ({ hints: [{ id: "pause", key: "space", label: frozen ? "resume" : "pause", onPress: freeze }] }), [frozen, resource.data, resource.epoch]);
  usePaneNoticeFooter({ registrationId: "time-sales:notices", focused, notices: [...(data?.gaps ?? []), ...(resource.transport ? [resource.transport] : [])] });
  usePaneStatusFooter({ registrationId: "time-sales:status", loading: resource.loading, error: resource.error,
    info: data ? [{ id: "feed", parts: [{ text: `${data.feed === "sip" ? "real-time" : "15m delayed"} · ${tapeTimeSeconds(data.asOf)} UTC`, tone: "muted" }] },
      ...(frozen ? [{ id: "paused", parts: [{ text: "paused", tone: "warning" as const }] }] : []),
      ...(!data.connected || resource.snapshotOnly ? [{ id: "snapshot", parts: [{ text: "snapshot", tone: "warning" as const }] }] : [])] : [] });
  const selectTab = (value: string) => { setTab(value); setDetail(null); setSelected(null); };
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: selectTab, focused: focused && !detail });
  const tabRows = tabsInHeader ? 0 : 1;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view time and sales" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={selectTab} focused={focused && !detail} dense />}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} empty={!!data && !rows.length} subject={tab === "quotes" ? "NBBO observations" : "trade observations"}>
      {data && stats ? <DataTableStackView<TapeRow> columns={tab === "quotes" ? QUOTES : TRADES} items={rows}
        focused={focused} rootWidth={width} rootHeight={Math.max(3, height - tabRows)}
        selection={{ kind: "id", selectedId: selected, getId: (row) => row.id, onChange: setSelected }}
        onActivate={(row) => { setPaused({ data, epoch: resource.epoch }); setDetail({ row, epoch: resource.epoch }); }} getItemKey={(row) => row.id}
        sortColumnId={null} sortDirection="desc" freezeFirstColumn
        detailOpen={!!detail && !!resource.data} onBack={() => setDetail(null)} detailTitle={detail?.trade ? `Trade ${detail.trade.id}` : "Quote"}
        detailContent={detail && resource.data ? <TapeDetail row={detail} data={data} width={width} /> : null}
        rootBefore={<StatGrid width={width} items={[
          ...(tab === "quotes" ? [
            { id: "spread", label: "Spread", value: spreads.median == null ? "--" : `${spreads.median.toFixed(2)} bp`, detail: "median" },
            { id: "widest", label: "Widest", value: spreads.widest == null ? "--" : `${spreads.widest.toFixed(2)} bp` },
            ...(spreads.abnormal ? [{ id: "abnormal", label: "Locked", value: String(spreads.abnormal), tone: "warning" as const, detail: "or crossed" }] : []),
          ] : [
            { id: "vwap", label: "VWAP", value: tapePrice(stats.vwap, tradeDigits), detail: `${tapeQuantity(stats.volume)} shares since ${stats.from ? tapeClockMs(stats.from) : "--"}` },
            { id: "range", label: "Range", value: `${tapePrice(stats.low, tradeDigits)} to ${tapePrice(stats.high, tradeDigits)}`, detail: `last ${rank(stats.pricePercentile)}` },
          ]),
          ...(data.session.high != null && data.session.low != null ? [{ id: "session", label: "Session", value: `${tapePrice(data.session.low, tradeDigits)} to ${tapePrice(data.session.high, tradeDigits)}` }] : []),
        ]} />}
        renderCell={(row, column) => {
          if (row.trade) {
            const trade = row.trade;
            return { text: column.id === "time" ? tapeClockMs(trade.timestamp) : column.id === "price" ? tapePrice(trade.price, tradeDigits)
              : column.id === "size" ? tapeQuantity(trade.size) : column.id === "venue" ? trade.exchange
              : column.id === "conditions" ? trade.conditions.join(" ") : trade.tape,
              color: trade.size >= 10_000 ? colors.warning : column.id === "price" ? colors.text : colors.textMuted };
          }
          const quote = row.quote!, spread = quoteSpread(quote);
          return { text: column.id === "time" ? tapeClockMs(quote.timestamp) : column.id === "bid" ? tapePrice(quote.bid, quoteDigits) : column.id === "ask" ? tapePrice(quote.ask, quoteDigits)
            : column.id === "bidSize" ? tapeQuantity(quote.bidSize) : column.id === "askSize" ? tapeQuantity(quote.askSize)
            : column.id === "bidExchange" ? quote.bidExchange : column.id === "askExchange" ? quote.askExchange
            : spread.bps == null ? "--" : spread.bps.toFixed(2), color: spread.state === "normal" ? colors.text : colors.warning };
        }} emptyStateTitle="No observations in this window." /> : null}
    </PaneStatusBody>
  </Box>;
}
function TapeDetail({ row, data, width }: { row: TapeRow; data: TapeSnapshot; width: number }) {
  const trade = row.trade, quote = row.quote;
  return <Box width={width} flexDirection="column" paddingX={1}>
    <KeyValueRow label="As of UTC" value={tapeTime((trade ?? quote)!.timestamp)} />
    {trade ? <>
      <KeyValueRow label="Price" value={tapePrice(trade.price)} />
      <KeyValueRow label="Shares" value={tapeQuantity(trade.size)} detail={trade.size >= 10_000 ? "large print" : undefined} />
      <KeyValueRow label="Venue" value={trade.exchange} detail={`Tape ${trade.tape}`} />
    </> : quote ? <>
      <KeyValueRow label="Bid" value={tapePrice(quote.bid)} detail={`${tapeQuantity(quote.bidSize)} round lots · ${quote.bidExchange}`} />
      <KeyValueRow label="Ask" value={tapePrice(quote.ask)} detail={`${tapeQuantity(quote.askSize)} round lots · ${quote.askExchange}`} />
      <KeyValueRow label="Spread" value={tapePrice(quoteSpread(quote).spread)} detail={quoteSpread(quote).state} />
    </> : null}
    <KeyValueRow label="Conditions" value={(trade ?? quote)!.conditions.join(" ") || "--"} />
    <KeyValueRow label="Window UTC" value={tapeTime(data.observedFrom)} detail={`${data.corrections} corrections · ${data.cancels} cancels`} />
  </Box>;
}
