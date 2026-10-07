import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { CreditFact, CreditHeadroom, CreditInstrument } from "../../../api-client/credit-documents";
import { Button, ChartTableHeader, DataTableStackView, DetailScrollBody, ExternalLinkText, KeyValueRow, Notice, PaneStatusBody, QueryBar, Section, usePaneStatusFooter, type StatItem } from "../../../components";
import { useAsyncResource, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { fetchCreditInstrument } from "./client";
import { comparatorSymbol, covenantNumber, covenantTerms, creditPercent, factColumns, factValue, fieldLabel, hasAmendments, headroomTone, NO_VALUE, sentence, structuredFields } from "./model";

const LABEL_WIDTH = 16;
const MATCH = { exact: "Exact", whitespace: "Whitespace normalized", nfkc_whitespace: "Unicode and whitespace normalized" } as Record<string, string>;

/** The verbatim filing text, set apart from the metadata by a rule; never reflowed or restyled. */
function Quote({ text, width }: { text: string; width: number }) {
  const colors = useThemeColors(), desktop = useUiCapabilities().nativePaneChrome === true;
  return <Box paddingLeft={1} border={desktop ? undefined : ["left"]} borderColor={colors.borderFocused}
    style={desktop ? { borderLeft: `2px solid ${colors.borderFocused}`, paddingLeft: "calc(1.5 * var(--cell-w))" } : undefined} data-gloom-role="credit-quote">
    <Text width={Math.max(1, width - 2)} wrapMode="word" wrapText fg={colors.textBright}>{text}</Text>
  </Box>;
}
function LabeledRow({ label, children }: { label: string; children: ReactNode }) {
  const colors = useThemeColors();
  return <Box height={1} flexDirection="row" overflow="hidden">
    <Box width={LABEL_WIDTH} flexShrink={0}><Text fg={colors.textDim}>{label}</Text></Box>
    {children}
  </Box>;
}
function CreditFactEvidence({ fact, width, scrollRef }: { fact: CreditFact; width: number; scrollRef: RefObject<ScrollBoxRenderable | null> }) {
  const colors = useThemeColors(), host = useRendererHost();
  const inner = Math.max(1, width - 2);
  const terms = covenantTerms(fact), structured = terms ? null : structuredFields(fact);
  const rows = terms?.fields ?? structured ?? [{ label: "Value", value: factValue(fact) }];
  return <DetailScrollBody ref={scrollRef} resetScrollKey={fact.id}>
    {rows.map((row) => <KeyValueRow key={row.label} label={row.label} value={row.value} detail={row.detail} labelWidth={LABEL_WIDTH}
      tone={row.value === NO_VALUE || row.value === "Not computable" ? "muted" : undefined} />)}
    {terms?.reason ? <Box paddingLeft={LABEL_WIDTH} width={inner}><Notice tone="muted">{terms.reason}</Notice></Box> : null}
    {terms?.definition ? <Section title="Definition"><Text width={inner} wrapMode="word" wrapText fg={colors.text}>{terms.definition}</Text></Section> : null}
    <Section title="Filing text"><Quote text={fact.quote} width={inner} /></Section>
    <Section title="Source">
      <LabeledRow label="Filing">
        <Text fg={colors.text} attributes={TextAttributes.BOLD}>{`${fact.form} · filed ${fact.filedAt}`}</Text>
        <Text fg={colors.textDim}>{"  "}</Text>
        <ExternalLinkText url={fact.filingUrl} label="Open filing" color={colors.borderFocused} onOpen={(url) => void host.openExternal(url)} />
      </LabeledRow>
      <KeyValueRow label="Period" value={fact.asOf} detail={fact.periodEnd && fact.periodEnd !== fact.asOf ? `period end ${fact.periodEnd}` : undefined} labelWidth={LABEL_WIDTH} />
      {fact.effectiveDate && fact.effectiveDate !== fact.asOf && fact.effectiveDate !== fact.filedAt ? <KeyValueRow label="Effective" value={fact.effectiveDate} labelWidth={LABEL_WIDTH} tone={fact.status === "pending" ? "warning" : undefined} /> : null}
      <KeyValueRow label="Revision" value={fieldLabel(fact.status)} detail={fact.status === "pending" ? "Not yet in effect" : fact.supersedesId ? "Supersedes earlier disclosure" : "Original observation"} labelWidth={LABEL_WIDTH} tone={fact.status === "pending" ? "warning" : undefined} />
      <KeyValueRow label="Confidence" value={`${Math.round(fact.confidence * 100)}%`} labelWidth={LABEL_WIDTH} />
      <KeyValueRow label="Text match" value={MATCH[fact.quoteMatchMode] ?? fieldLabel(fact.quoteMatchMode)} detail={`chars ${fact.quoteOffset}–${fact.quoteOffset + fact.quoteSourceLength} · ${fact.language}`} labelWidth={LABEL_WIDTH} />
    </Section>
  </DetailScrollBody>;
}
/** The covenant the detail was opened from: which test, where it stands, most important first so a short pane keeps the lead. */
function covenantFigures(covenant: CreditHeadroom, fact: CreditFact | undefined): StatItem[] {
  return [
    { id: "covenant", label: "Covenant", value: sentence(covenant.metric), wide: true },
    { id: "headroom", label: "Headroom", value: creditPercent(covenant.headroomPercent), tone: headroomTone(covenant) ?? (covenant.headroomPercent === null ? "muted" : undefined) },
    { id: "limit", label: "Limit", value: `${comparatorSymbol(covenant.comparator, covenant.inclusive)} ${covenantNumber(covenant.threshold, fact)}` },
    { id: "reported", label: "Reported", value: covenantNumber(covenant.current, fact), tone: covenant.current === null ? "muted" : undefined, detail: covenant.current === null ? undefined : covenant.asOf },
    { id: "status", label: "Status", value: fieldLabel(covenant.status), tone: covenant.status === "breach" ? "negative" : "muted" },
  ];
}
export function CreditInstrumentDetail({ symbol, instrument, width, height, focused, accessKey, view, setView, covenant, captured, pro, onUpgrade, openId, setOpen }: {
  openId: string | null; setOpen: (id: string | null) => void;
  symbol: string; instrument: CreditInstrument; width: number; height: number; focused: boolean; accessKey: string;
  view: string; setView: (view: string) => void; covenant?: CreditHeadroom | null; captured?: CreditInstrument | null; pro: boolean; onUpgrade: () => void;
}) {
  const colors = useThemeColors(), host = useRendererHost();
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loader = useCallback(() => captured ? Promise.resolve(captured) : fetchCreditInstrument(symbol, instrument.id), [symbol, instrument.id, accessKey, captured]);
  const resource = useAsyncResource(loader, { initialData: () => captured ?? instrument });
  const data = resource.data ?? instrument;
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`credit:fact:selected:${instrument.id}:${view}`, null);
  const amended = hasAmendments(data);
  const rows = useMemo(() => view === "history" ? amended ? [...data.history!].sort((a, b) => b.filedAt.localeCompare(a.filedAt) || a.field.localeCompare(b.field)) : []
    : [...data.facts].sort((a, b) => a.field.localeCompare(b.field) || a.factKey.localeCompare(b.factKey)), [data, view, amended]);
  // Opened from a covenant, the cursor starts on that covenant's terms.
  const selected = rows.find((row) => row.id === selectedId) ?? rows.find((row) => row.id === covenant?.id) ?? rows[0] ?? null;
  const open = rows.find((row) => row.id === openId) ?? null;
  usePaneStatusFooter({ registrationId: "credit:instrument", loading: resource.loading, error: resource.error,
    hints: selected ? [{ id: "credit:open-source", key: "o", label: "pen filing", onPress: () => void host.openExternal((open ?? selected).filingUrl) }] : [] });
  const columns = useMemo(() => factColumns(view, width), [view, width]);
  const query = <QueryBar width={width} view={{ value: view, options: [{ value: "terms", label: "Current terms" }, { value: "history", label: "Amendment history" }], onChange: (value) => { setView(value); setOpen(null); } }} />;
  // Why headroom is missing stays beside the figures it explains.
  const reason = covenant?.reason && covenant.status !== "compliant" && covenant.status !== "breach" ? covenant.reason : null;
  const header = covenant ? <Box flexDirection="column">
    <ChartTableHeader width={width} height={height - (reason ? 2 : 0)} tableRows={rows.length} tableColumns={columns} query={query} figures={covenantFigures(covenant, data.facts.find((fact) => fact.id === covenant.id))} />
    {reason ? <Box paddingX={1} width={width}><Notice tone="muted">{reason}</Notice></Box> : null}
  </Box> : query;
  if (view === "history" && (!pro || !amended)) {
    const first = [...data.facts].sort((a, b) => a.filedAt.localeCompare(b.filedAt))[0];
    return <Box flexDirection="column" flexGrow={1} minHeight={0}>
      {header}
      <PaneStatusBody empty emptyTitle={pro ? "No amendments recorded." : "Amendment history is part of Gloom Pro."}
        emptyMessage={pro && first ? `Tracked since the ${first.form} filed ${first.filedAt}.` : undefined}
        actions={pro ? undefined : <Button label="Upgrade to Pro" onPress={onUpgrade} />} />
    </Box>;
  }
  return <DataTableStackView<CreditFact> columns={columns} items={rows} sortColumnId={view === "history" ? "filed" : "field"} sortDirection={view === "history" ? "desc" : "asc"} focused={focused} rootWidth={width} rootHeight={height}
    rootBefore={header}
    getItemKey={(row) => row.id} selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelected }}
    renderCell={(row, column) => ({ text: column.id === "field" ? fieldLabel(row.field) : column.id === "value" ? factValue(row) : column.id === "asOf" ? row.asOf : column.id === "filed" ? row.filedAt : fieldLabel(row.status),
      color: row.status === "superseded" ? colors.textDim : row.status === "pending" && column.id === "status" ? colors.warning : column.id === "field" ? colors.textBright : colors.text,
      keepColorWhenSelected: row.status === "pending" && column.id === "status" })}
    onActivate={(row) => setOpen(row.id)} detailOpen={!!open} onBack={() => setOpen(null)} detailTitle={open ? fieldLabel(open.field) : undefined}
    detailScrollRef={detailScrollRef} detailContent={open ? <CreditFactEvidence scrollRef={detailScrollRef} fact={open} width={width} /> : null}
    emptyStateTitle="No supported terms in this disclosure."
    selectedTextOverridesCellColor freezeFirstColumn showHorizontalScrollbar />;
}
