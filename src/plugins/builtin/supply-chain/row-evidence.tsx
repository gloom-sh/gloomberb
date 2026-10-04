import { useRef } from "react";
import type { SupplyRow } from "../../../api-client/supply-chain";
import { Badge, DetailScrollBody, ExternalLink, KeyValueRow, Section, StatGrid, type StatItem } from "../../../components";
import { useShortcut } from "../../../react/input";
import { scrollByLines } from "../../../state/pane-scroll-registry";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { counterpartyKind, counterpartyKindLabel, dollars, ROLE_COLORS, roleLabel, shareParts, sourceLabel } from "./model";
import { canShowQuote, corroborationLabel, evidenceDate, evidenceLabel, isUnconfirmed, tierLabel } from "./trust";

function SourceQuote({ row, quote, width }: { row: SupplyRow; quote: string; width: number }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  return <Box marginY={1} paddingLeft={desktop ? 0 : 1} border={desktop ? undefined : ["left"]} borderColor={ROLE_COLORS[row.role]}
    style={desktop ? { borderLeft: `3px solid ${ROLE_COLORS[row.role]}`, paddingLeft: 12, paddingTop: 4, paddingBottom: 4, backgroundColor: blendHex(colors.bg, ROLE_COLORS[row.role], 0.07), borderRadius: 2 } : undefined}>
    <Text fg={colors.textBright} width={Math.max(1, width - 6)} wrapMode="word" wrapText>{quote}</Text>
  </Box>;
}

export function RowEvidence({ row, focusId, width, height, focused }: { row: SupplyRow; focusId?: string; width: number; height: number; focused: boolean }) {
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  useShortcut((event) => {
    if (!focused || !scrollRef.current || event.defaultPrevented) return;
    const delta = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    scrollByLines(scrollRef.current, delta);
  });
  const share = shareParts(row, focusId);
  const figures: StatItem[] = [
    ...(share ? [{ id: "share", label: "Share", value: share.value, detail: share.basis }] : []),
    ...(row.usd !== null ? [{ id: "value", label: "Value", value: dollars(row) }] : []),
    { id: "period", label: "Period", value: row.fiscalYear ? `FY ${row.fiscalYear}` : row.period, detail: row.fiscalYear ? row.period : undefined },
    { id: "published", label: "Published", value: evidenceDate(row), detail: evidenceLabel(row) },
    { id: "confidence", label: "Confidence", value: `${Math.round(row.confidence * 100)}%` },
  ];
  const kind = counterpartyKindLabel(row);
  return <Box width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0}>
    <DetailScrollBody ref={scrollRef} resetScrollKey={row.id}>
      <StatGrid items={figures} width={width} />
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Box flexDirection="row" gap={1}><Badge tone={isUnconfirmed(row) ? "neutral" : "accent"} label={evidenceLabel(row)} />
          {row.leadStatus === "verified" ? <Badge tone="positive" label="Verified" /> : null}</Box>
        <KeyValueRow label="Reporting company" value={row.reportingEntity.name} labelWidth={20} />
        <KeyValueRow label="Relationship" value={`${roleLabel(row.role)} · ${row.direction === "in" ? "inbound" : row.direction === "out" ? "outbound" : "mutual"}`} color={ROLE_COLORS[row.role]} labelWidth={20} />
        {kind ? <KeyValueRow label="Counterparty type" value={counterpartyKind(row) === "group" ? "Aggregate concentration group" : "Undisclosed by the filer"} labelWidth={20} /> : null}
        {isUnconfirmed(row) ? <KeyValueRow label="Why unconfirmed" value={row.whyUnconfirmed ?? "Awaiting independent confirmation"} labelWidth={20} /> : null}
        <KeyValueRow label="Corroboration" value={corroborationLabel(row)} labelWidth={20} />
        {row.pctScope ? <KeyValueRow label="Percentage scope" value={row.pctScope} labelWidth={20} /> : null}
        {row.firstSeenAt ? <KeyValueRow label="First seen" value={row.firstSeenAt.slice(0, 10)} detail={row.lastSeenAt ? `last seen ${row.lastSeenAt.slice(0, 10)}` : undefined} labelWidth={20} /> : null}
        {!isUnconfirmed(row) && row.lastConfirmedAt ? <KeyValueRow label="Last confirmed" value={row.lastConfirmedAt.slice(0, 10)} labelWidth={20} /> : null}
        {row.evidence?.length ? [...row.evidence].sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || a.tier - b.tier || b.publishedAt.localeCompare(a.publishedAt)).map((item) =>
          <Section key={item.id} title={item.title || item.publisher} width={Math.max(1, width - 2)}>
            <KeyValueRow label="Publisher" value={item.publisher} detail={item.publishedAt.slice(0, 10)} labelWidth={20} />
            <KeyValueRow label="Evidence" value={tierLabel(item.tier)} detail={item.status !== "active" ? item.status : item.textOrigin === "asr" ? "Speech transcript" : undefined} labelWidth={20} />
            {item.verificationStatus === "lead" ? <KeyValueRow label="Verification" value="Unconfirmed supporting item" labelWidth={20} /> : null}
            {item.value !== null ? <KeyValueRow label={item.valueKind ?? "Source value"} value={`${item.value.toLocaleString("en-US")} ${[item.currency, item.valueUnit].filter(Boolean).join(" ")}`} labelWidth={20} /> : null}
            {canShowQuote(item) && item.quote ? <SourceQuote row={row} quote={item.quote} width={width} /> : <KeyValueRow label="Quotation" value={item.textOrigin === "snippet" ? "Original text not verified" : "Link only"} labelWidth={20} />}
            {canShowQuote(item) && item.englishGloss ? <KeyValueRow label="English gloss" value={item.englishGloss} labelWidth={20} /> : null}
            <ExternalLink url={item.url} label="Open source" />
          </Section>) : <>
          <KeyValueRow label="Disclosure" value={`${sourceLabel(row)} · filed ${row.filedDate ?? "--"}`} labelWidth={20} />
          {row.quoteMatchMode ? <KeyValueRow label="Evidence match" value={row.quoteMatchMode === "exact" ? "Exact text" : row.quoteMatchMode === "whitespace" ? "Whitespace normalized" : "Unicode and whitespace normalized"} labelWidth={20} /> : null}
          <SourceQuote row={row} quote={row.quote} width={width} />
          <ExternalLink url={row.filingUrl} label={`Open ${row.form ?? "filing"}${row.filedDate ? ` filed ${row.filedDate}` : ""}`} />
        </>}
      </Box>
    </DetailScrollBody>
  </Box>;
}
