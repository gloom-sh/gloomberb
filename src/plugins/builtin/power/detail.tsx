import { isAccessDenied } from "../../../api-client/errors";
import { useCallback, useEffect } from "react";
import type { PowerProject } from "../../../api-client/power";
import { DetailScrollBody, ExternalLinkText, KeyValueRow, PaneLinkMenu, QueryBar, SectionHeading, usePagedRows, usePaneNoticeFooter, usePaneStatusFooter } from "../../../components";
import { usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import type { RefObject } from "react";
import { PowerGeneration } from "./generation";
import { loadPowerDetail } from "./client";
import { powerNumber, powerPercent, titleCase, type PowerRow } from "./model";

function ProjectFacts({ row }: { row: PowerProject }) {
  const colors = useThemeColors();
  const facts: Array<[string, string | number | null]> = [
    ["Status", row.statusRaw ?? titleCase(row.status)], ["Capacity (MW)", row.capacityMw], ["Technology", row.technology ?? titleCase(row.fuel)],
    ["Location", [row.county, row.state, row.country].filter(Boolean).join(", ")], ["Grid / zone", [row.region, row.zone].filter(Boolean).join(" · ")],
    ["Developer", row.developer], ["Utility", row.utility], ["Requested", row.requestedDate], ["Proposed service", row.proposedDate],
    ["Completed", row.completedDate], ["Withdrawn", row.withdrawnDate], ["Period", row.period], ["Published as of", row.asOf],
    ["Observed UTC", row.observedAt], ["Revision", row.revision], ["Confidence", powerPercent(row.confidence)],
  ];
  return <>
    {facts.map(([label, value]) => <KeyValueRow key={label} label={label} value={typeof value === "number" ? powerNumber(value) : value ?? "--"} detail={typeof value === "string" && ["Requested", "Proposed service", "Completed", "Withdrawn", "Published as of"].includes(label) ? /^\d{4}$/.test(value) ? "year precision" : /^\d{4}-Q[1-4]$/.test(value) ? "quarter precision" : /^\d{4}-\d{2}$/.test(value) ? "month precision" : /^\d{4}-\d{2}-\d{2}$/.test(value) ? "day precision" : undefined : undefined} labelWidth={20} />)}
    {row.entities.length ? <SectionHeading title="Mapped companies" /> : null}
    {row.entities.map((entity) => <KeyValueRow key={`${entity.entityId}:${entity.role}`} label={titleCase(entity.role)} value={entity.name}
      detail={`${entity.tickers.map((t) => t.exchange ? `${t.ticker}:${t.exchange}` : t.ticker).join(", ")} · ${powerPercent(entity.confidence)} confidence`} labelWidth={20} />)}
    {Object.keys(row.metrics).length ? <SectionHeading title="Reported context" /> : null}
    {Object.entries(row.metrics).map(([label, value]) => <KeyValueRow key={label} label={label === "revenueUsd" ? "Retail revenue (USD)" : titleCase(label.replace(/([a-z])([A-Z])/g, "$1 $2"))} value={value === null ? "--" : String(value)} labelWidth={24} />)}
    <SectionHeading title="Primary evidence" />
    <KeyValueRow label="Location in source" value={row.sourceLocator} labelWidth={20} />
    <PaneLinkMenu><ExternalLinkText url={row.sourceUrl} label="Open primary document" /></PaneLinkMenu>
    {Object.entries(row.evidence).map(([label, value]) => <Box key={label} flexDirection="column" paddingTop={1}>
      <Text fg={colors.textDim}>{label}</Text><Text fg={colors.textBright}>{typeof value === "string" ? value : JSON.stringify(value)}</Text>
    </Box>)}
  </>;
}
export function PowerDetailView({ row, scope, scrollRef, snapshot, focused, width, height }: { row: PowerRow; scope: string; scrollRef: RefObject<ScrollBoxRenderable | null>; snapshot: boolean; focused: boolean; width: number; height: number }) {
  const [view, setView] = usePluginPaneState("power:detail-view", "evidence");
  const id = row.project?.id;
  const loader = useCallback(async ({ offset, force, signal }: { offset: number; force: boolean; signal: AbortSignal }) => {
    const result = await loadPowerDetail(id!, scope, force, offset, signal);
    return { ...result, rows: result.payload.revisions, hasMore: result.payload.hasMore, nextOffset: result.payload.nextOffset };
  }, [id, scope]);
  const pages = usePagedRows(id && !snapshot ? loader : null, { getId: (revision) => `${revision.snapshotId}:${revision.revision}` });
  useEffect(() => {
    if (pages.hasMore && !pages.loading && !pages.loadingMore && !pages.moreError) pages.loadMore();
  }, [pages.hasMore, pages.loading, pages.loadingMore, pages.moreError, pages.loadMore]);
  const denied = isAccessDenied(pages.error) || isAccessDenied(pages.moreError);
  usePaneNoticeFooter({ registrationId: "power:detail-notices", focused, notices: [pages.error?.message, pages.moreError?.message, ...pages.pages.map((page) => page.refreshError)].filter((notice): notice is string => !!notice) });
  usePaneStatusFooter({ registrationId: "power:detail-status", loading: pages.loading || pages.loadingMore,
    hints: pages.error || pages.moreError ? [{ id: "retry-evidence", key: "r", label: "etry evidence", onPress: pages.reload }] : [] });
  const project = denied ? undefined : pages.pages[0]?.payload.project ?? row.project;
  const revisions = denied ? [] : pages.rows;
  const hasGeneration = !!project && Object.keys(project.metrics).some((key) => /^generation.+Mwh$/.test(key));
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
    {hasGeneration ? <QueryBar width={width} view={{ value: view, options: [{ value: "evidence", label: "Evidence" }, { value: "generation", label: "Monthly generation" }], onChange: setView }} /> : null}
    {hasGeneration && view === "generation" ? <PowerGeneration project={project!} width={width} height={Math.max(3, height - 1)} focused={focused} /> : <DetailScrollBody ref={scrollRef} resetScrollKey={row.id}>
    {denied ? <Text>Project evidence is unavailable for this account.</Text> : project ? <ProjectFacts row={project} /> : <>
      {Object.entries(row.cells).filter(([, value]) => ["string", "number"].includes(typeof value) || value === null).map(([key, value]) =>
        <KeyValueRow key={key} label={titleCase(key.replace(/([a-z])([A-Z])/g, "$1 $2"))} value={value == null ? "--" : /Rate$/.test(key) ? powerPercent(Number(value)) : String(value)} labelWidth={22} />)}
      {row.history ? <>
        <KeyValueRow label="History basis" value={row.history.basis === "published" ? "Published period" : "Observed snapshot"} labelWidth={22} />
        <KeyValueRow label="Published as of" value={row.history.asOf ?? "--"} labelWidth={22} />
        <KeyValueRow label="Observed UTC" value={row.history.observedAt} labelWidth={22} />
        <SectionHeading title="Primary evidence" />
        <PaneLinkMenu>{row.history.sourceUrls.map((url, index) => <Box key={url} paddingBottom={1}><ExternalLinkText url={url} label={`Open primary document ${index + 1}`} /></Box>)}</PaneLinkMenu>
      </> : null}
      {row.exposure ? <>
        <KeyValueRow label="Published as of" value={row.exposure.asOf ?? "--"} labelWidth={22} />
        <KeyValueRow label="Observed UTC" value={row.exposure.observedAt} labelWidth={22} />
        <SectionHeading title="Primary evidence" />
        <PaneLinkMenu>{row.exposure.sourceUrls.map((url, index) => <Box key={url} paddingBottom={1}><ExternalLinkText url={url} label={`Open primary document ${index + 1}`} /></Box>)}</PaneLinkMenu>
      </> : null}
      {row.coverage?.reason ? <Box paddingY={1}><Text>{row.coverage.reason}</Text></Box> : null}
      {row.coverage ? <PaneLinkMenu><ExternalLinkText url={row.coverage.sourceUrl} label="Open primary document" /></PaneLinkMenu> : null}
    </>}
    {revisions.length > 1 ? <><SectionHeading title="Revision history" />{revisions.map((revision) =>
      <KeyValueRow key={`${revision.snapshotId}:${revision.revision}`} label={revision.observedAt.slice(0, 10)} value={`${powerNumber(revision.capacityMw)} MW · ${titleCase(revision.status)}`}
        detail={`revision ${revision.revision} · published ${revision.asOf ?? "date not supplied"}`} labelWidth={20} />)}</> : null}
  </DetailScrollBody>}
  </Box>;
}
