import { useMemo, useState } from "react";
import { Box } from "gloomberb/ui";
import { usePaneSettingValue, useShortcut } from "gloomberb/react";
import { DataTableStackView, KeyValueRow, PaneStatusBody, Tabs, usePaneFooter, usePaneNoticeFooter, usePaneStatusFooter, usePaneTicker, type DataTableColumn } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import type { TapeQuote, TapeSnapshot, TapeTrade } from "../../../api-client/tape";
import { canonicalExchange } from "../../../utils/exchanges";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { newestFirst, quoteKey, quoteSpread, tapeClockMs, tapePrice, tapeQuantity, tapeStatistics, tapeTime, tradeKey } from "./model";
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
const noop = () => {};
const rank = (value: number | null) => value == null ? "pctl --" : `${value.toFixed(0)} pctl`;
type TapeRow = { id: string; trade?: TapeTrade; quote?: TapeQuote };

export function TimeSalesPane(props: PaneProps) {
  const { symbol, ticker } = usePaneTicker();
  const session = useResearchCloudSession();
  const exchange = canonicalExchange(ticker?.metadata.exchange ?? "");
  if (!symbol) return <PaneStatusBody empty emptyTitle="Select a US equity." subject="time and sales" />;
  return <TimeSalesView key={`${symbol}:${exchange}:${session.requestKey}`} {...props} symbol={symbol} exchange={exchange} />;
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
    info: data ? [{ id: "feed", parts: [{ text: `Alpaca ${data.feed === "sip" ? "SIP" : "SIP 15m delayed"} · ${tapeTime(data.asOf)} UTC`, tone: "muted" }] },
      ...(frozen ? [{ id: "paused", parts: [{ text: "paused", tone: "warning" as const }] }] : []),
      ...(!data.connected ? [{ id: "snapshot", parts: [{ text: "snapshot", tone: "warning" as const }] }] : [])] : [] });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view time and sales" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    <Tabs tabs={TABS} activeValue={tab} onSelect={(value) => { setTab(value); setDetail(null); setSelected(null); }} focused={focused && !detail} dense />
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} empty={!!data && !rows.length} subject={tab === "quotes" ? "NBBO observations" : "trade observations"}>
      {data && stats ? <DataTableStackView<TapeRow> columns={tab === "quotes" ? QUOTES : TRADES} items={rows}
        focused={focused} rootWidth={width} rootHeight={Math.max(3, height - 1)}
        selection={{ kind: "id", selectedId: selected, getId: (row) => row.id, onChange: setSelected }}
        onActivate={(row) => { setPaused({ data, epoch: resource.epoch }); setDetail({ row, epoch: resource.epoch }); }} getItemKey={(row) => row.id}
        sortColumnId={null} sortDirection="desc" onHeaderClick={noop} freezeFirstColumn
        detailOpen={!!detail && !!resource.data} onBack={() => setDetail(null)} detailTitle={detail?.trade ? `Trade ${detail.trade.id}` : "Quote"}
        detailContent={detail && resource.data ? <TapeDetail row={detail} data={data} width={width} /> : null}
        rootBefore={<Box flexDirection="column" flexShrink={0} paddingX={1}>
          <KeyValueRow labelWidth={16} label="Last trade" value={tapePrice(stats.latest?.price ?? null)} detail={`${rank(stats.pricePercentile)} / ${stats.count} prints · ${stats.asOf ? tapeClockMs(stats.asOf) : "--"} UTC`} />
          <KeyValueRow labelWidth={16} label="Observed VWAP" value={tapePrice(stats.vwap)} detail={`${tapeQuantity(stats.volume)} shares · ${stats.from ? tapeClockMs(stats.from) : "--"} to ${stats.asOf ? tapeClockMs(stats.asOf) : "--"}`} />
          <KeyValueRow labelWidth={16} label="Observed range" value={`${tapePrice(stats.low)} to ${tapePrice(stats.high)}`} detail={data.session.high != null && data.session.low != null ? `Session ${tapePrice(data.session.low)} to ${tapePrice(data.session.high)} · ${tapeTime(data.session.asOf)} UTC` : undefined} />
        </Box>}
        renderCell={(row, column) => {
          if (row.trade) {
            const trade = row.trade;
            return { text: column.id === "time" ? tapeClockMs(trade.timestamp) : column.id === "price" ? tapePrice(trade.price)
              : column.id === "size" ? tapeQuantity(trade.size) : column.id === "venue" ? trade.exchange
              : column.id === "conditions" ? trade.conditions.join(" ") : trade.tape,
              color: trade.size >= 10_000 ? colors.warning : column.id === "price" ? colors.text : colors.textMuted };
          }
          const quote = row.quote!, spread = quoteSpread(quote);
          return { text: column.id === "time" ? tapeClockMs(quote.timestamp) : column.id === "bid" ? tapePrice(quote.bid) : column.id === "ask" ? tapePrice(quote.ask)
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
