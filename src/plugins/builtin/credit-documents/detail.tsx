import { useCallback, useMemo, useRef, type RefObject } from "react";
import type { CreditFact, CreditHeadroom, CreditInstrument } from "../../../api-client/credit-documents";
import { ActionRow, DataTableStackView, KeyValueRow, QueryBar, usePaneStatusFooter } from "../../../components";
import { useAsyncResource, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { fetchCreditInstrument } from "./client";
import { covenantNumber, creditPercent, creditValue, factValue, fieldLabel } from "./model";

const FACT_COLUMNS = [
  { id: "field", label: "Term", width: 26, align: "left" as const },
  { id: "value", label: "Disclosed value", width: 40, flexGrow: 1, align: "left" as const },
  { id: "asOf", label: "As of", width: 12, align: "left" as const },
  { id: "filed", label: "Filed", width: 12, align: "left" as const },
  { id: "status", label: "Revision", width: 13, align: "left" as const },
];
function CreditFactEvidence({ fact, width, height, scrollRef }: { fact: CreditFact; width: number; height: number; scrollRef: RefObject<ScrollBoxRenderable | null> }) {
  const colors = useThemeColors(), host = useRendererHost(), desktop = useUiCapabilities().nativePaneChrome;
  return <ScrollBox ref={scrollRef} width={width} height={desktop ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
    {typeof fact.value === "object" && fact.value !== null ? <Box flexDirection="column" paddingY={1}>{Object.entries(fact.value).filter(([,value]) => value !== null).map(([key,value]) => <Text key={key} width={Math.max(1,width-2)} wrapMode="word" wrapText fg={colors.textBright}>{`${fieldLabel(key)}: ${creditValue(value)}`}</Text>)}</Box> : <KeyValueRow label="Value" value={factValue(fact)} labelWidth={17} />}
    <KeyValueRow label="Period" value={fact.asOf} detail={fact.periodEnd && fact.periodEnd !== fact.asOf ? `period end ${fact.periodEnd}` : undefined} labelWidth={17} />
    <KeyValueRow label="Disclosure" value={`${fact.form} · ${fact.filedAt}`} detail={`${Math.round(fact.confidence * 100)}% confidence`} labelWidth={17} />
    {fact.effectiveDate && fact.effectiveDate !== fact.asOf && fact.effectiveDate !== fact.filedAt ? <KeyValueRow label="Effective" value={fact.effectiveDate} labelWidth={17} /> : null}
    <KeyValueRow label="Revision" value={fieldLabel(fact.status)} detail={fact.status === "pending" ? "Not yet in effect" : fact.supersedesId ? "Supersedes earlier disclosure" : "Original observation"} labelWidth={17} />
    <KeyValueRow label="Evidence span" value={`${fact.quoteOffset}–${fact.quoteOffset + fact.quoteSourceLength}`} detail={fact.language} labelWidth={17} />
    <KeyValueRow label="Text match" value={fact.quoteMatchMode === "exact" ? "Exact" : fact.quoteMatchMode === "whitespace" ? "Whitespace normalized" : "Unicode and whitespace normalized"} labelWidth={17} />
    <Box paddingY={1} width={Math.max(1,width-2)}><Text width={Math.max(1,width-2)} wrapMode="word" wrapText fg={colors.textBright}>{fact.quote}</Text></Box>
    <ActionRow label="Open filing" onPress={() => void host.openExternal(fact.filingUrl)} />
    <Text width={Math.max(1,width-2)} wrapMode="char" wrapText fg={colors.textDim}>{fact.filingUrl}</Text>
  </ScrollBox>;
}
export function CreditInstrumentDetail({ symbol, instrument, width, height, focused, accessKey, view, setView, covenant, captured, pro, openId, setOpen }: {
  openId: string | null; setOpen: (id: string | null) => void;
  symbol: string; instrument: CreditInstrument; width: number; height: number; focused: boolean; accessKey: string;
  view: string; setView: (view: string) => void; covenant?: CreditHeadroom | null; captured?: CreditInstrument | null; pro: boolean;
}) {
  const colors = useThemeColors(), host = useRendererHost();
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loader = useCallback(() => captured ? Promise.resolve(captured) : fetchCreditInstrument(symbol, instrument.id), [symbol, instrument.id, accessKey, captured]);
  const resource = useAsyncResource(loader, { initialData: () => captured ?? instrument });
  const data = resource.data ?? instrument;
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`credit:fact:selected:${instrument.id}:${view}`, null);
  const rows = useMemo(() => [...(view === "history" ? data.history ?? [] : data.facts)].sort((a, b) => view === "history" ? b.filedAt.localeCompare(a.filedAt) || a.field.localeCompare(b.field) : a.field.localeCompare(b.field) || a.factKey.localeCompare(b.factKey)), [data, view]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const open = rows.find((row) => row.id === openId) ?? null;
  usePaneStatusFooter({ registrationId: "credit:instrument", loading: resource.loading, error: resource.error,
    hints: selected ? [{ id: "credit:open-source", key: "o", label: "pen filing", onPress: () => void host.openExternal((open ?? selected).filingUrl) }] : [] });
  return <DataTableStackView<CreditFact> columns={FACT_COLUMNS} items={rows} sortColumnId={view === "history" ? "filed" : "field"} sortDirection={view === "history" ? "desc" : "asc"} focused={focused} rootWidth={width} rootHeight={height}
    rootBefore={<Box flexDirection="column">
      <QueryBar width={width} view={{ value: view, options: [{ value: "terms", label: "Current terms" }, { value: "history", label: "Amendment history" }], onChange: (value) => { setView(value); setOpen(null); } }} />
      {covenant ? <Box paddingX={1} flexDirection="column">
        <KeyValueRow label={covenant.metric} value={`${covenant.comparator === "maximum" ? covenant.inclusive === false ? "<" : "≤" : covenant.inclusive === false ? ">" : "≥"} ${covenantNumber(covenant.threshold,data.facts.find((fact) => fact.id === covenant.id))}`} detail={`${creditPercent(covenant.headroomPercent)} headroom · ${fieldLabel(covenant.status)}`} labelWidth={25} />
        {covenant.reason ? <Text width={Math.max(1,width-2)} wrapMode="word" wrapText fg={colors.textDim}>{covenant.reason}</Text> : null}
      </Box> : null}
    </Box>}
    getItemKey={(row) => row.id} selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (row) => row.id, onChange: setSelected }}
    renderCell={(row, column) => ({ text: column.id === "field" ? fieldLabel(row.field) : column.id === "value" ? factValue(row) : column.id === "asOf" ? row.asOf : column.id === "filed" ? row.filedAt : fieldLabel(row.status), color: row.status === "superseded" ? colors.textDim : row.status === "pending" && column.id === "status" ? colors.warning : column.id === "field" ? colors.textBright : colors.text })}
    onActivate={(row) => setOpen(row.id)} detailOpen={!!open} onBack={() => setOpen(null)} detailTitle={open ? fieldLabel(open.field) : undefined}
    detailScrollRef={detailScrollRef} detailContent={open ? <CreditFactEvidence scrollRef={detailScrollRef} fact={open} width={width} height={height - 1} /> : null}
    emptyStateTitle={view === "history" ? pro ? "No earlier instrument revisions stored." : "Amendment history requires Gloom Pro." : "No supported terms in this disclosure."}
    selectedTextOverridesCellColor freezeFirstColumn showHorizontalScrollbar />;
}
