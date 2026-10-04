import { enrollmentBasis, enrollmentSeries, enrollmentValue } from "./history";
import { useCallback, useMemo, useRef } from "react";
import type { CatalystDetail, CatalystEvent } from "../../../api-client/catalysts";
import { ActionRow, ChartTableHeader, DataTableView, KeyValueRow, PaneStatusBody, Section, usePagedRows, usePaneStatusFooter, usePaneTabs, useChartTableSelection, type DataTableColumn, useTableLoadMore, type PageRequest } from "../../../components";
import { usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { UpgradeLabel } from "../shared/locked-rows";
import { catalystAgency, catalystDate, catalystDateBasis, catalystFacts, catalystLabel, changeValue } from "./model";
import { humanLabel } from "../shared/research-cells";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { loadCatalystDetail } from "./client";

function Evidence({ event, width, height }: { event: CatalystEvent; width: number; height: number }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const facts = catalystFacts(event);
  const procedures = Array.isArray(event.metadata?.proceduralStatements) ? event.metadata.proceduralStatements.filter((value): value is string => typeof value === "string") : [];
  const documents = Array.isArray(event.metadata?.documents) ? event.metadata.documents.filter((value): value is { url: string; title?: string; label?: string } => !!value && typeof value === "object" && "url" in value && typeof value.url === "string" && /^https?:\/\//.test(value.url)) : [];
  return <ScrollBox width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} contentOptions={{ paddingX: 1 }}>
    <KeyValueRow label="Classification" value={`${catalystLabel(event.type)} · ${catalystAgency(event.agency)} · ${event.country ?? event.jurisdiction}`} labelWidth={18} />
    <KeyValueRow label="Status" value={humanLabel(event.status)} detail={`Revision ${event.revision}`} labelWidth={18} />
    <KeyValueRow label="Announced" value={catalystDate(event, "announced")} labelWidth={18} />
    {event.effectiveDate ? <KeyValueRow label={catalystDateBasis(event, "effective")} value={catalystDate(event, "effective")} labelWidth={18} /> : null}
    {event.deadlineDate ? <KeyValueRow label={catalystDateBasis(event, "deadline")} value={catalystDate(event, "deadline")} labelWidth={18} /> : null}
    <KeyValueRow label="Observed (UTC)" value={catalystDate(event, "observed")} labelWidth={18} />
    <KeyValueRow label="Confidence" value={`${Math.round(event.confidence * 100)}%`} labelWidth={18} />
    {facts.map((fact) => <KeyValueRow key={fact.label} label={fact.label} value={fact.value} labelWidth={18} />)}
    {event.summary && event.summary !== event.title && event.summary !== event.quote ? <Box paddingY={1}><Text fg={colors.text} wrapText width="100%">{event.summary}</Text></Box> : null}
    {event.parties.length ? <Section title="Parties" width={Math.max(20, width - 2)}>{event.parties.map((party, i) => <KeyValueRow key={`${party.name}:${i}`} label={party.role ?? "Party"} value={party.name} detail={party.ticker ? `${party.ticker} · ${party.exchange ?? ""} · ${Math.round(party.confidence * 100)}% match` : "Unlinked"} labelWidth={18} />)}</Section> : null}
    <Section title="Evidence" width={Math.max(20, width - 2)}>
      <Text fg={colors.textBright} wrapText width="100%">{event.quote ?? "No quoted passage. Open the primary document."}</Text>
      {event.quoteMatchMode ? <KeyValueRow label="Quote support" value={event.quoteMatchMode === "exact" ? "Exact passage" : "Normalized passage"} labelWidth={18} /> : null}
      <Text fg={colors.textDim} wrapText width="100%">{event.sourceUrl}</Text>
    </Section>
    {procedures.length ? <Section title="Procedure" width={Math.max(20, width - 2)}>{procedures.map((statement, i) => <Box key={i} paddingBottom={1}><Text fg={colors.text} wrapText width="100%">{statement}</Text></Box>)}</Section> : null}
    {documents.length ? <Section title="Documents" width={Math.max(20, width - 2)}>{documents.map((document) => <ActionRow key={document.url} label={document.title ?? document.label ?? "Primary document"} onPress={() => void host.openExternal(document.url)} />)}</Section> : null}
    {event.opinion ? <Section title={event.opinion.label} width={Math.max(20, width - 2)}>
      <KeyValueRow label="Expected impact" value={catalystLabel(event.opinion.direction)} detail={`${Math.round(event.opinion.confidence * 100)}% confidence`} labelWidth={18} />
      <Text fg={colors.text} wrapText width="100%">{event.opinion.rationale}</Text><Text fg={colors.textDim} wrapText width="100%">{event.opinion.quote}</Text>
    </Section> : null}
    {event.changes.length ? <Section title="Revision changes" width={Math.max(20, width - 2)}>{event.changes.map((change, i) => <KeyValueRow key={`${change.field}:${i}`} label={humanLabel(change.field)} value={`${changeValue(change.before)} → ${changeValue(change.after)}`} labelWidth={18} />)}</Section> : null}
  </ScrollBox>;
}
export function CatalystEventDetail({ event, accessKey, snapshot, width, height, focused, initialTab = "evidence", openUpgrade }: {
  event: CatalystEvent; accessKey: string; snapshot?: CatalystDetail; width: number; height: number; focused: boolean; initialTab?: string; openUpgrade: () => void;
}) {
  const host = useRendererHost();
  const colors = useThemeColors();
  const [tab, setTab] = usePluginPaneState<string>(`catalyst:detail-tab:${event.id}`, initialTab);
  const [revisionId, setRevisionId] = usePluginPaneState<string | null>(`catalyst:revision:${event.id}`, null);
  const loader = useCallback(async ({ offset, force, signal }: PageRequest) => {
    const result = snapshot ? { payload: snapshot, stale: false, refreshError: null } : await loadCatalystDetail(event.id, accessKey, force, offset, signal);
    const payload = result.payload;
    return { ...result, rows: payload.history, hasMore: !snapshot && payload.access?.pro !== false && payload.historyHasMore === true,
      nextOffset: (payload.historyOffset ?? offset) + payload.history.length };
  }, [event.id, accessKey, snapshot]);
  const resource = usePagedRows(loader, { getId: (row) => row.revisionId });
  const page = resource.pages[0];
  const data = page?.payload;
  const rows = useMemo(() => data ? resource.rows : [event], [data, resource.rows, event]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(scrollRef, resource.hasMore, resource.loadMore);
  usePaneRefreshKey(resource.reload, { focused });
  const revision = rows.find((row) => row.revisionId === revisionId) ?? data?.event ?? event;
  const series = useMemo(() => enrollmentSeries(rows, colors), [rows, colors]);
  const columns = useMemo<DataTableColumn[]>(() => [{ id: "revision", label: "Rev", width: 4, align: "right" }, { id: "observed", label: "Observed (UTC)", width: 16, align: "left" },
    { id: "status", label: "Status", width: width < 100 ? 15 : 20, align: "left" }, ...(event.type === "clinical" ? [{ id: "enrollment", label: "Participants", width: width < 100 ? 18 : 22, align: "right" as const }] : []),
    { id: "changes", label: "Changes", width: width < 100 ? 18 : 24, flexGrow: 1, align: "left" }], [width, event.type]);
  const link = useChartTableSelection({ rows, getId: (row) => row.revisionId, getDate: (row) => enrollmentValue(row) === null ? null : new Date(row.observedAt), selectedId: revision.revisionId, onSelect: setRevisionId, focused: focused && tab === "history", enabled: series.length > 0 });
  const { strip, rows: tabRows } = usePaneTabs({ tabs: [{ value: "evidence", label: "Evidence" }, { value: "history", label: "History" }], activeValue: tab, onSelect: setTab, focused, dense: true });
  usePaneStatusFooter({ registrationId: "catalyst-detail", loading: resource.loading || resource.loadingMore, error: resource.error?.message ?? resource.moreError?.message ?? page?.refreshError, stale: page?.stale,
    hints: [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(revision.sourceUrl) }] });
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
    {strip}
    {tab === "history" ? <PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error?.message : null} subject="event history"><DataTableView<CatalystEvent>
      scrollRef={scrollRef} onBodyScrollActivity={loadMore} items={rows} sortColumnId={null} sortDirection="desc" columns={columns}
      rootBefore={series.length ? <ChartTableHeader width={width} height={Math.max(3, height - tabRows)} tableRows={rows.length} tableColumns={columns} chart={{ series, remoteKind: "clinical-enrollment-history", formatValue: (value) => `${value.toLocaleString("en-US")} participants`, ...link }} /> : undefined}
      rootWidth={width} rootHeight={Math.max(3, height - tabRows)} focused={focused} getItemKey={(row) => row.revisionId}
      selection={{ kind: "id", selectedId: revision.revisionId, getId: (row) => row.revisionId, onChange: setRevisionId }}
      onActivate={(row) => { setRevisionId(row.revisionId); setTab("evidence"); }}
      renderCell={(row, column) => ({ text: column.id === "revision" ? String(row.revision) : column.id === "observed" ? catalystDate(row, "observed") : column.id === "status" ? humanLabel(row.status) : column.id === "enrollment" ? enrollmentValue(row) === null ? "--" : `${enrollmentValue(row)?.toLocaleString("en-US")} ${enrollmentBasis(row)}` : row.changes.map((change) => `${humanLabel(change.field)}: ${changeValue(change.before)} → ${changeValue(change.after)}`).join("; ") || "First observed" })}
      bodyAfter={data?.access && data.access.lockedRows > 0 ? <UpgradeLabel text="Upgrade for complete event history" onPress={openUpgrade} role="catalyst-history-upgrade" /> : undefined}
      emptyStateTitle="History is collecting." /></PaneStatusBody>
      : <Evidence event={revision} width={width} height={Math.max(3, height - tabRows)} />}
  </Box>;
}
