import type { ReactNode } from "react";
import type { CloudFilingEventPayload } from "../../../../api-client";
import type {
  DistressAttribution,
  DistressDesignation,
  GoingConcernDisclosure,
  InsolvencyNotice,
} from "../../../../api-client/distress";
import { BulletList, ExternalLinkText, Prose, READING_WIDTH } from "../../../../components";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text } from "../../../../ui";
import { truncateToDisplayWidth } from "../../../../utils/format";
import {
  assessmentHorizonLabel,
  cellText,
  cikLabel,
  DATE_BASIS_LABELS,
  designationDate,
  designationKindLabel,
  designationRemarks,
  exchangeLabel,
  filingDate,
  filingItemLines,
  filingTicker,
  insolvencyKindLabel,
  insolvencyNoticeLabel,
  isoDay,
  MISSING,
  noticeStatusLabel,
  noticeTypeLabel,
  plainText,
  registryLabel,
  VERDICT_LABELS,
} from "./model";

/** Wide enough for "Company number" and a gap. */
const LABEL_WIDTH = 16;

/**
 * Detail bodies for the distress lists. Everything here is source text drawn
 * as plain text, with the record's own dates, and the licence terms each
 * source publishes under beside its rows.
 */

function Field({ label, value, width, bright = false }: { label: string; value: string; width: number; bright?: boolean }) {
  const colors = useThemeColors();
  const valueWidth = Math.max(8, width - LABEL_WIDTH);
  return (
    <Box flexDirection="row" width={width} flexShrink={0}>
      <Box width={LABEL_WIDTH} flexShrink={0} overflow="hidden">
        <Text fg={colors.textDim}>{label}</Text>
      </Box>
      <Box flexDirection="column" width={valueWidth} flexShrink={0}>
        <Prose text={value || MISSING} width={valueWidth} color={bright ? colors.textBright : colors.text} figures={false} />
      </Box>
    </Box>
  );
}

function LinkField({ label, url, width }: { label: string; url: string; width: number }) {
  const colors = useThemeColors();
  const valueWidth = Math.max(8, width - LABEL_WIDTH);
  return (
    <Box flexDirection="row" width={width} height={1} flexShrink={0} overflow="hidden">
      <Box width={LABEL_WIDTH} flexShrink={0} overflow="hidden">
        <Text fg={colors.textDim}>{label}</Text>
      </Box>
      <ExternalLinkText url={url} label={truncateToDisplayWidth(url.replace(/^https?:\/\//, ""), valueWidth)} />
    </Box>
  );
}

function Gap() {
  return <Box height={1} flexShrink={0} />;
}

function Muted({ text, width }: { text: string; width: number }) {
  const colors = useThemeColors();
  return <Prose text={text} width={width} color={colors.textDim} figures={false} />;
}

function Body({ width, children }: { width: number; children: ReactNode }) {
  return <Box flexDirection="column" width={Math.min(width, READING_WIDTH)}>{children}</Box>;
}

/** The licence a source's rows come under, as the source asks for it to be shown. */
function Attribution({ attribution, width }: { attribution: DistressAttribution | null; width: number }) {
  if (!attribution) return null;
  const dataset = [
    attribution.dataset,
    [attribution.version, attribution.year == null ? null : String(attribution.year)].filter(Boolean).join(", "),
  ].filter(Boolean).join(" · ");
  return (
    <>
      <Field label="Publisher" value={cellText(attribution.organization)} width={width} />
      {dataset ? <Field label="Dataset" value={cellText(dataset)} width={width} /> : null}
      {attribution.datasetUrls.map((url) => <LinkField key={url} label="" url={url} width={width} />)}
      <Field label="Licence" value={cellText(attribution.licence)} width={width} />
      <LinkField label="" url={attribution.licenceUrl} width={width} />
      <Gap />
      <Muted text={cellText(attribution.notice)} width={width} />
    </>
  );
}

export function FilingDetail({ event, width }: { event: CloudFilingEventPayload; width: number }) {
  const colors = useThemeColors();
  const bodyWidth = Math.min(width, READING_WIDTH);
  const ticker = filingTicker(event);
  const cik = cikLabel(event.company.cik);
  const items = filingItemLines(event);
  const points = event.summary ? plainText(event.summary).split("\n").map((line) => cellText(line)).filter(Boolean) : [];
  return (
    <Body width={width}>
      <Field label="Filed" value={`${filingDate(event)} · ${event.form ?? "8-K"}`} width={bodyWidth} />
      <Field label="Ticker" value={ticker ?? "No trading symbol"} width={bodyWidth} />
      {cik ? <Field label="CIK" value={cik} width={bodyWidth} /> : null}
      {items.map((line, index) => <Field key={line} label={index === 0 ? "Items" : ""} value={line} width={bodyWidth} />)}
      {event.headline ? (
        <>
          <Gap />
          <Prose text={cellText(event.headline)} width={bodyWidth} color={colors.textBright} />
        </>
      ) : null}
      {points.length > 0 ? <BulletList items={points} width={bodyWidth} color={colors.text} /> : null}
      <Gap />
      <LinkField label="Filing" url={event.docUrl} width={bodyWidth} />
      <Gap />
      <Muted
        text="Source: SEC EDGAR. The headline and summary are generated from the filing text; the filing is the authoritative record."
        width={bodyWidth}
      />
    </Body>
  );
}

function monthName(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return /^\d{4}-\d{2}$/.test(month) && Number.isFinite(date.getTime())
    ? date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    : month;
}

export function GoingConcernDetail({ row, width }: { row: GoingConcernDisclosure; width: number }) {
  const colors = useThemeColors();
  const bodyWidth = Math.min(width, READING_WIDTH);
  const cik = cikLabel(row.cik);
  const paragraphs = plainText(row.text).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return (
    <Body width={width}>
      <Field label="Filed" value={`${isoDay(row.filed_at)} · ${row.form}`} width={bodyWidth} />
      <Field label="Period end" value={isoDay(row.period_end)} width={bodyWidth} />
      <Field label="Ticker" value={row.ticker ? cellText(row.ticker) : "No trading symbol"} width={bodyWidth} />
      {cik ? <Field label="CIK" value={cik} width={bodyWidth} /> : null}
      <Field label="Disclosure" value={VERDICT_LABELS[row.verdict]} width={bodyWidth} bright />
      <Field label="Assessed over" value={assessmentHorizonLabel(row.within_one_year)} width={bodyWidth} />
      {row.quote.trim() ? (
        <>
          <Gap />
          <Prose text={`"${cellText(row.quote)}"`} width={bodyWidth} color={colors.textBright} figures={false} />
        </>
      ) : null}
      {/* A summary that only wraps the quote says nothing new. */}
      {row.summary.trim() && !cellText(row.summary).includes(cellText(row.quote)) ? (
        <>
          <Gap />
          <Prose text={cellText(row.summary)} width={bodyWidth} color={colors.text} figures={false} />
        </>
      ) : null}
      {paragraphs.length > 0 ? <Gap /> : null}
      {paragraphs.map((paragraph, index) => (
        <Box key={index} flexDirection="column" flexShrink={0}>
          {index > 0 ? <Gap /> : null}
          <Prose text={cellText(paragraph)} width={bodyWidth} color={colors.textMuted} figures={false} />
        </Box>
      ))}
      {row.text_truncated ? <Muted text="The note continues in the filing." width={bodyWidth} /> : null}
      <Gap />
      <LinkField label="Filing" url={row.filing_url} width={bodyWidth} />
      <Gap />
      <Muted
        text={`Source: SEC Financial Statement and Notes data set, ${monthName(row.dataset_month)}, XBRL element ${cellText(row.tag)}. The disclosure reading and summary are generated from the note text; the filing is the authoritative record.`}
        width={bodyWidth}
      />
    </Body>
  );
}

export function DesignationDetail({ row, width, attributions }: { row: DistressDesignation; width: number; attributions: DistressAttribution[] }) {
  const bodyWidth = Math.min(width, READING_WIDTH);
  const official = row.date_basis !== "first_observed";
  const remarks = designationRemarks(row.remarks);
  return (
    <Body width={width}>
      <Field label="Status" value={designationKindLabel(row.kind)} width={bodyWidth} bright />
      <Field
        label={DATE_BASIS_LABELS[row.date_basis]}
        value={official ? designationDate(row) : `${designationDate(row)}, the exchange does not publish the designation date`}
        width={bodyWidth}
      />
      <Field label="Exchange" value={exchangeLabel(row.exchange)} width={bodyWidth} />
      <Field label="Code" value={row.local_code} width={bodyWidth} />
      {row.symbol ? <Field label="Symbol" value={row.symbol} width={bodyWidth} /> : null}
      <Field label="Name" value={cellText(row.entity_name)} width={bodyWidth} />
      {row.entity_name_en ? <Field label="English name" value={cellText(row.entity_name_en)} width={bodyWidth} /> : null}
      <Field label="On list as of" value={isoDay(row.last_seen_at)} width={bodyWidth} />
      {row.ended_at ? <Field label="Removed" value={`${isoDay(row.ended_at)}, no longer on the exchange's list`} width={bodyWidth} /> : null}
      {remarks.map((line, index) => <Field key={line} label={index === 0 ? "Remarks" : ""} value={line} width={bodyWidth} />)}
      <Gap />
      {row.notice_url ? <LinkField label="Notice" url={row.notice_url} width={bodyWidth} /> : null}
      <LinkField label="List" url={row.source_url} width={bodyWidth} />
      <Gap />
      <Attribution attribution={attributions.find((entry) => entry.source === row.source) ?? null} width={bodyWidth} />
    </Body>
  );
}

export function InsolvencyDetail({ row, width, attributions }: { row: InsolvencyNotice; width: number; attributions: DistressAttribution[] }) {
  const bodyWidth = Math.min(width, READING_WIDTH);
  const france = row.country === "FR";
  return (
    <Body width={width}>
      <Field label="Procedure" value={insolvencyKindLabel(row.kind)} width={bodyWidth} bright />
      <Field label="Notice" value={insolvencyNoticeLabel(row)} width={bodyWidth} />
      {!france && row.raw_code.trim() ? <Field label="Notice code" value={cellText(row.raw_code)} width={bodyWidth} /> : null}
      <Field label={france ? "Judgment date" : "Procedure date"} value={isoDay(row.notice_date)} width={bodyWidth} />
      <Field label="Published" value={isoDay(row.published_date)} width={bodyWidth} />
      {row.court.trim() ? <Field label="Court" value={cellText(row.court)} width={bodyWidth} /> : null}
      <Field label={registryLabel(row.country)} value={row.registry_id} width={bodyWidth} />
      <Field label="Country" value={france ? "France" : row.country === "GB" ? "United Kingdom" : row.country} width={bodyWidth} />
      {/* A correction says which notice it corrects; an initial notice needs no line. */}
      {row.notice_type !== "annonce" ? (
        <Field
          label="Correction"
          value={row.original_notice_id ? `${noticeTypeLabel(row.notice_type)} of ${row.original_notice_id}` : noticeTypeLabel(row.notice_type)}
          width={bodyWidth}
        />
      ) : null}
      <Field label="Status" value={noticeStatusLabel(row.status)} width={bodyWidth} />
      <Field label="Notice ID" value={row.notice_id} width={bodyWidth} />
      <Gap />
      <LinkField label="Notice page" url={row.notice_url} width={bodyWidth} />
      <Gap />
      <Attribution attribution={attributions.find((entry) => entry.source === row.source) ?? null} width={bodyWidth} />
    </Body>
  );
}
