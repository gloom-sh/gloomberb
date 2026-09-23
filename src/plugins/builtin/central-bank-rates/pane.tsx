import { useCallback, useMemo } from "react";
import { Box } from "../../../ui";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useShortcut, useUpdatedAgo } from "../../../public/react";
import { CompositeChart, MarketBoardStack, PaneStatusBody, StatGrid, statGridRows, usePaneNoticeFooter, usePaneStatusLinkFooter, type StatItem } from "../../../components";
import { colors } from "../../../theme/colors";
import { ApiRequestError } from "../../../api-client/errors";
import type { CentralBankRow } from "../../../api-client/central-bank-rates";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedCentralBankRates, loadCentralBankRates } from "./client";
import { hasNoPolicyRate, policyBoardRow, policyChange, policyHistory, policyLevel, policyNotices, policyRate } from "./model";

const PANELS = [{ id: "main" }];
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);

function PolicyDetail({ row, width, height }: { row: CentralBankRow; width: number; height: number }) {
  const history = useMemo(() => policyHistory(row), [row]);
  const series = useMemo(() => [staticSeries(history.map((point) => ({ date: new Date(point.date), observedAt: new Date(point.date), value: point.value })),
    { id: row.id, label: row.instrument, color: colors.positive, calendarSpaced: true, style: "step" })], [row, history]);
  const p = row.percentile;
  // The chart shows the rank window, so the range carries no window or sample
  // count; short details keep the figures several to a row.
  const items: StatItem[] = [
    { id: "level", label: row.range ? "Target range" : "Policy rate", value: policyLevel(row),
      detail: `${p.value == null ? "--" : p.value.toFixed(0)} pctl 1Y` },
    { id: "move", label: "Last move", value: policyChange(row), detail: row.lastChangeDate ?? undefined },
    // A target range ranks and charts its midpoint, which the band's range would not say.
    { id: "range", label: "1Y range", value: `${policyRate(p.min)} to ${policyRate(p.max)}`, detail: row.range ? "midpoint" : undefined },
    { id: "asOf", label: "As of", value: row.asOf ?? "--", tone: row.status === "stale" ? "warning" : undefined,
      detail: [row.publicationFrequency, row.lagDays == null ? null : `${row.lagDays}d lag`, row.status === "stale" ? "stale" : null]
        .filter(Boolean).join(" · ") || undefined },
    { id: "meeting", label: "Next meeting", value: row.nextMeeting?.date ?? "--" },
    { id: "source", label: "Source", value: row.source?.toUpperCase() ?? "--", detail: row.sourceSeriesIds.join(", ") || undefined },
    { id: "instrument", label: "Instrument", value: row.instrument, detail: row.centralBank ?? undefined, wide: true },
  ];
  const summaryHeight = statGridRows(items, width);
  return <Box flexDirection="column" width={width} height={height}>
    <StatGrid items={items} width={width} />
    <PaneStatusBody empty={!history.some((point) => point.value != null)} subject="policy history" emptyTitle="No policy history available.">
      <CompositeChart series={series} panels={PANELS} width={width} height={Math.max(3, height - summaryHeight)} showLegend={false}
        navigable={false} showTimeAxis formatAxisValue={policyRate} remoteKind="central-bank-policy-history" />
    </PaneStatusBody>
  </Box>;
}

export function CentralBankRatesPane({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadCentralBankRates(force), [session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: getCachedCentralBankRates, clearOnError: clearDenied });
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const data = resource.data?.payload;
  const rows = useMemo(() => data?.rows.filter((row) => !hasNoPolicyRate(row)).map(policyBoardRow) ?? [], [data]);
  const selected = rows.find((row) => row.id === openId) ?? rows.find((row) => row.id === selectedId);
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => { if (focused && event.name === "r") { event.preventDefault(); void resource.reload(); } });
  usePaneNoticeFooter({ registrationId: "central-bank-rates:notices", focused,
    notices: [...(data ? policyNotices(data) : []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: "central-bank-rates", focused, loading: resource.loading, error: resource.error,
    url: selected?.observation.sourceUrl ?? null, showOpenHint: true,
    info: data ? [
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : []),
      ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(data.status !== "available" ? [{ id: "partial", parts: [{ text: data.status, tone: "warning" as const }] }] : []),
    ] : [],
  });
  return <Box width={width} height={height} flexDirection="column">
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!resource.loading && !resource.error && !data} subject="central bank rates">
      {data ? <MarketBoardStack rows={rows} width={width} height={height} focused={focused}
        selectedId={selectedId} onSelectedIdChange={setSelectedId} openId={openId} onOpenIdChange={setOpenId}
        valueWidth={14} changeLabel="LAST MOVE" labelHeader="JURISDICTION" labelWidth={14} labelDetailHeader="INSTRUMENT" renderDetail={(row) => <PolicyDetail row={row.observation} width={width} height={Math.max(5, height - 2)} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
