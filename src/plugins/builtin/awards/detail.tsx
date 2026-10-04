import { useMemo, useRef } from "react";
import type { AwardRow } from "../../../api-client/awards";
import { ActionRow, KeyValueRow, PaneStatusBody, Section, StatGrid, usePagedRows, usePaneNoticeFooter, usePaneStatusFooter, useTableLoadMore } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { fetchAward, loadAward } from "./client";
import { awardPeriod, awardTypeLabel, money } from "./model";
import { UpgradeLabel } from "../shared/locked-rows";

export function AwardDetail({ row, accessKey, width, height, focused, openAward, openChildren, openUpgrade }: {
  row: AwardRow; accessKey: string; width: number; height: number; focused: boolean; openAward: (id: string) => void;
  openChildren: (type: "subaward" | "modification") => void; openUpgrade: () => void;
}) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const loader = useMemo(() => {
    const cursors = new Map<number, string>();
    return async ({ offset, signal, force }: { offset: number; signal: AbortSignal; force: boolean }) => {
      const result = offset === 0 ? await loadAward(row.id, accessKey, force)
        : { payload: await fetchAward(row.id, undefined, signal, cursors.get(offset)), stale: false, refreshError: null };
      if (result.payload.nextRevisionsCursor) cursors.set(offset + result.payload.revisions.length, result.payload.nextRevisionsCursor);
      return { ...result, rows: result.payload.revisions, hasMore: !!result.payload.nextRevisionsCursor && !result.payload.locked };
    };
  }, [row.id, accessKey]);
  const resource = usePagedRows(loader, { getId: (revision) => revision.id });
  usePaneRefreshKey(resource.reload, { focused });
  const loaded = resource.pages[0], detail = loaded?.payload;
  const current = detail?.row ?? row;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(scrollRef, resource.hasMore, resource.loadMore);
  usePaneStatusFooter({ registrationId: "awards:detail", loading: resource.loading || resource.loadingMore, error: resource.error?.message ?? resource.moreError?.message, stale: loaded?.stale });
  usePaneNoticeFooter({ registrationId: "awards:detail-notice", focused, notices: loaded?.refreshError ? [loaded.refreshError] : [] });
  const labelWidth = width < 85 ? 18 : 23;
  return <ScrollBox ref={scrollRef} scrollY width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} contentOptions={{ paddingX: 1 }} onMouseScroll={loadMore}>
    <StatGrid width={Math.max(1, width - 2)} items={[
      { id: "value", label: `Value (${current.currency})`, value: money(current.awardAmount), detail: current.fieldAsOf?.awardAmount ? `as of ${current.fieldAsOf.awardAmount.slice(0, 10)}` : undefined },
      { id: "obligated", label: `Obligated (${current.currency})`, value: money(current.obligatedAmount), detail: current.fieldAsOf?.obligatedAmount ? `as of ${current.fieldAsOf.obligatedAmount.slice(0, 10)}` : undefined },
      { id: "ceiling", label: `Ceiling (${current.currency})`, value: money(current.ceilingAmount), detail: current.fieldAsOf?.ceilingAmount ? `as of ${current.fieldAsOf.ceilingAmount.slice(0, 10)}` : undefined },
    ]} />
    <Section title="Contract" width={width - 2}>
      <KeyValueRow label="Awardee" value={current.recipient.name} labelWidth={labelWidth} />
      <KeyValueRow label={current.entity?.parentName && current.entity.parentName !== current.recipient.name ? "Listed parent" : "Listed company"} value={current.entity ? `${current.entity.ticker} · ${current.entity.parentName ?? current.entity.legalName}` : "Unresolved"} labelWidth={labelWidth} />
      <KeyValueRow label="Agency" value={current.agency.name} detail={current.agency.parentName && current.agency.parentName !== current.agency.name ? current.agency.parentName : undefined} labelWidth={labelWidth} />
      <KeyValueRow label={current.dateBasis === "period-start" ? "Period start date" : current.dateBasis === "publication" ? "Published" : "Awarded"} value={current.awardDate} detail={`${current.jurisdiction} · ${awardTypeLabel(current.awardType)}`} labelWidth={labelWidth} />
      {current.awardStatus ? <KeyValueRow label="Status" value={current.awardStatus} labelWidth={labelWidth} /> : null}
      {current.dataBasis === "bulk-latest-transaction" ? <KeyValueRow label="Record basis" value="Latest published transaction" labelWidth={labelWidth} /> : null}
      <KeyValueRow label="Performance period" value={awardPeriod(current)} labelWidth={labelWidth} />
      <KeyValueRow label="Performance place" value={[current.placeOfPerformance?.city, current.placeOfPerformance?.region, current.placeOfPerformance?.country].filter(Boolean).join(", ") || "--"} labelWidth={labelWidth} />
      <KeyValueRow label="NAICS / PSC" value={`${current.naics ?? "--"} / ${current.psc ?? "--"}`} labelWidth={labelWidth} />
      {current.classifications?.map((classification) => <KeyValueRow key={`${classification.scheme}:${classification.code}`} label={classification.scheme.toUpperCase()} value={classification.code} detail={classification.label} labelWidth={labelWidth} />)}
      <KeyValueRow label="Award id" value={current.sourceAwardId} labelWidth={labelWidth} />
      {current.parentAwardId ? <KeyValueRow label="Parent award" value={current.parentAwardId} labelWidth={labelWidth} /> : null}
      {current.recipient.identifiers?.map((identifier) => <KeyValueRow key={identifier.scheme + identifier.value} label={identifier.scheme.toUpperCase()} value={identifier.value} labelWidth={labelWidth} />)}
      {current.description ? <Box paddingY={1}><Text fg={colors.text} width={width - 2} wrapMode="word" wrapText>{current.description}</Text></Box> : null}
    </Section>
    {current.revenueComparison ? <Section title="Annual revenue comparison" width={width - 2}>
      <KeyValueRow label="Award / revenue" value={`${current.revenueComparison.percent.toFixed(2)}%`} detail={current.revenueComparison.basis === "obligated" ? "Obligated amount" : "Award value"} labelWidth={labelWidth} />
      <KeyValueRow label="Annual revenue" value={`${current.currency} ${money(current.revenueComparison.annualRevenue)}`} labelWidth={labelWidth} />
      <KeyValueRow label="Revenue period" value={`${current.revenueComparison.periodStart} / ${current.revenueComparison.periodEnd}`} labelWidth={labelWidth} />
      <KeyValueRow label="Revenue filed" value={current.revenueComparison.filedAt.slice(0, 10)} labelWidth={labelWidth} />
      <KeyValueRow label="Revenue filing" value={current.revenueComparison.sourceUrl} labelWidth={labelWidth} />
      <ActionRow label="Open annual revenue filing" onPress={() => void host.openExternal(current.revenueComparison!.sourceUrl)} />
    </Section> : null}
    <Section title="Evidence" width={width - 2}>
      <KeyValueRow label="Observed (UTC)" value={current.observedAt.replace("T", " ").slice(0, 19)} labelWidth={labelWidth} />
      {current.dataEffectiveDate ? <KeyValueRow label="Record effective" value={current.dataEffectiveDate.slice(0, 10)} labelWidth={labelWidth} /> : null}
      <KeyValueRow label="Confidence" value={current.confidence == null ? "--" : `${Math.round(current.confidence * 100)}%`} labelWidth={labelWidth} />
      {current.entity ? <KeyValueRow label="Entity match" value={`${current.entity.method.replaceAll("-", " ")} · ${Math.round(current.entity.confidence * 100)}%`} labelWidth={labelWidth} /> : null}
      {current.evidenceQuote ? <Box paddingY={1}><Text fg={colors.textBright} width={width - 2} wrapMode="word" wrapText>{current.evidenceQuote}</Text></Box> : null}
      <Text fg={colors.textDim} width={width - 2} wrapMode="word" wrapText>{current.sourceUrl}</Text>
      {Object.entries(current.fieldSourceUrls ?? {}).map(([field, url]) => <ActionRow key={field} label={`Open ${({ obligatedAmount: "obligation", ceilingAmount: "ceiling", awardAmount: "award value", parentRecipient: "parent relationship" } as Record<string, string>)[field] ?? field.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase()} evidence${current.fieldAsOf?.[field] ? ` · ${current.fieldAsOf[field]!.slice(0, 10)}` : ""}`} onPress={() => void host.openExternal(url)} />)}
      {current.entity ? <KeyValueRow label="Entity evidence" value={current.entity.evidenceUrl} labelWidth={labelWidth} /> : null}
      {current.entity ? <ActionRow label="Open entity evidence" onPress={() => void host.openExternal(current.entity!.evidenceUrl)} /> : null}
    </Section>
    <PaneStatusBody loading={resource.loading && !detail} error={!detail ? resource.error?.message : null} subject="award revisions">
      {detail ? <>
        <Section title="Revisions" width={width - 2}>
          {resource.rows.map((revision) => <Box key={revision.id} flexDirection="column" paddingBottom={1}>
            <KeyValueRow label={revision.observedAt.slice(0, 10)} value={`${revision.award.currency} ${money(revision.award.obligatedAmount)} obligated · ${money(revision.award.ceilingAmount)} ceiling`} labelWidth={labelWidth} />
            <KeyValueRow label="Record" value={revision.id} detail={revision.supersedes ? `Supersedes ${revision.supersedes}` : "Original observation"} labelWidth={labelWidth} />
            <KeyValueRow label="Awardee" value={revision.award.recipient.name} labelWidth={labelWidth} />
            <KeyValueRow label="Agency" value={revision.award.agency.name} labelWidth={labelWidth} />
            <KeyValueRow label="Award date / value" value={`${revision.award.awardDate} · ${revision.award.currency} ${money(revision.award.awardAmount)}`} labelWidth={labelWidth} />
            <KeyValueRow label="Performance period" value={`${revision.award.periodStart ?? "--"} / ${revision.award.periodEnd ?? "--"}`} labelWidth={labelWidth} />
            <Text fg={colors.textDim} width={width - 2} wrapMode="word" wrapText>{revision.award.title}</Text>
            {revision.award.evidenceQuote ? <Text fg={colors.text} width={width - 2} wrapMode="word" wrapText>{revision.award.evidenceQuote}</Text> : null}
            <ActionRow label="Open revision source" onPress={() => void host.openExternal(revision.award.sourceUrl)} />
          </Box>)}
        </Section>
        <Section title="Subawards" width={width - 2}>
          {detail.subawards.length ? detail.subawards.slice(0, 50).map((award) => <ActionRow key={award.id} label={`${award.recipient.name} · ${award.currency} ${money(award.awardAmount)}`} onPress={() => openAward(award.id)} />) : <Text fg={colors.textDim}>No disclosed subawards.</Text>}
          {detail.truncated?.subawards || detail.subawards.length > 50 ? <ActionRow label="Open subcontract feed" onPress={() => openChildren("subaward")} /> : null}
        </Section>
        <Section title="Modifications" width={width - 2}>
          {detail.modifications.length ? detail.modifications.slice(0, 50).map((award) => <ActionRow key={award.id} label={`${award.awardDate} · ${award.modificationNumber ?? award.sourceAwardId} · ${award.currency} ${money(award.awardAmount)}`} onPress={() => openAward(award.id)} />) : <Text fg={colors.textDim}>No recorded modifications.</Text>}
          {detail.truncated?.modifications || detail.modifications.length > 50 ? <ActionRow label="Open contract action feed" onPress={() => openChildren("modification")} /> : null}
        </Section>
        <Section title="Contract relationships" width={width - 2}>
          {detail.edges.map((edge, index) => <KeyValueRow key={`${edge.awardId}:${index}`} label={edge.kind === "government-customer" ? "Government customer" : "Subcontractor"} value={`${edge.from.name} → ${edge.to.name}`} detail={`${edge.currency} ${money(edge.amount)}`} labelWidth={labelWidth} />)}
        </Section>
        {detail.locked ? <UpgradeLabel text="Upgrade for complete award evidence" onPress={openUpgrade} /> : null}
      </> : null}
    </PaneStatusBody>
  </ScrollBox>;
}
