import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  DataTableStackView,
  DetailScrollBody,
  KeyValueRow,
  PaneStatusBody,
  Prose,
  QueryBar,
  Section,
  StatGrid,
  usePagedRows,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PageRequest,
  type PaneFooterSegment,
  type PaneHint,
  type StatItem,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import {
  useDebouncedPluginPaneState,
  usePaneSettingValue,
  usePaneTitle,
  usePluginPaneState,
} from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { OpenFdaClient, parseOpenFdaDate } from "./client";
import {
  OPENFDA_PANE_ID,
  type DeviceReport,
  type DrugRecall,
  type DrugReport,
  type OpenFdaDataset,
  type OpenFdaRecord,
} from "./types";

const SEARCH_DEBOUNCE_MS = 350;
const LABEL_WIDTH = 14;

const DATASETS: ReadonlyArray<{ value: OpenFdaDataset; label: string }> = [
  { value: "drug", label: "Drug reports" },
  { value: "device", label: "Device reports" },
  { value: "recall", label: "Drug recalls" },
];

type ColumnId = "date" | "product" | "role" | "reactions" | "outcome" | "manufacturer" | "event" | "firm" | "class" | "status";
type RecordColumn = DataTableColumn & { id: ColumnId };

function recordColumns(dataset: OpenFdaDataset, width: number): RecordColumn[] {
  const wide = width >= 72;
  const date: RecordColumn = { id: "date", label: dataset === "recall" ? "Initiated" : "Received", width: 10, align: "left" };
  if (dataset === "drug") {
    return [
      date,
      { id: "product", label: "Drug", width: 14, align: "left", flexGrow: 1 },
      ...(wide ? [
        { id: "role" as const, label: "Role", width: 11, align: "left" as const },
        { id: "reactions" as const, label: "Reactions", width: 24, align: "left" as const, flexGrow: 3 },
      ] : []),
      { id: "outcome", label: "Outcome", width: 11, align: "left" },
    ];
  }
  if (dataset === "device") {
    return [
      date,
      { id: "product", label: "Device", width: 18, align: "left", flexGrow: 2 },
      ...(wide ? [{ id: "manufacturer" as const, label: "Manufacturer", width: 22, align: "left" as const, flexGrow: 1 }] : []),
      { id: "event", label: "Event", width: 11, align: "left" },
    ];
  }
  return [
    date,
    { id: "firm", label: "Firm", width: 16, align: "left", flexGrow: 1 },
    { id: "class", label: "Class", width: 9, align: "left" },
    ...(wide ? [
      { id: "status" as const, label: "Status", width: 10, align: "left" as const },
      { id: "product" as const, label: "Product", width: 20, align: "left" as const, flexGrow: 2 },
    ] : []),
  ];
}

const formatDate = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : "-");

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function cellFor(record: OpenFdaRecord, column: ColumnId): DataTableCell {
  if (column === "date") return { text: formatDate(record.date), value: record.date, color: colors.textMuted };
  switch (record.dataset) {
    case "drug":
      if (column === "product") return { text: record.product, color: colors.textBright };
      if (column === "role") return { text: record.role ? capitalize(record.role) : "-", color: colors.textDim };
      if (column === "reactions") return { text: record.reactions.join(", ") || "-", color: colors.text };
      if (column === "outcome") return { text: record.outcome ?? "-", color: colors.text };
      break;
    case "device":
      if (column === "product") return { text: record.product, color: colors.textBright };
      if (column === "manufacturer") return { text: record.manufacturer ?? "-", color: colors.text };
      if (column === "event") return { text: record.eventType ?? "-", color: colors.text };
      break;
    case "recall":
      if (column === "firm") return { text: record.firm, color: colors.textBright };
      if (column === "class") return { text: record.classification ?? "-", color: colors.text };
      if (column === "status") return { text: record.status ?? "-", color: colors.textDim };
      if (column === "product") return { text: record.product, color: colors.text };
      break;
  }
  return { text: "" };
}

function detailTitle(record: OpenFdaRecord): string {
  return record.dataset === "recall" ? record.firm : record.product;
}

function DrugReportDetail({ record, width }: { record: DrugReport; width: number }) {
  return (
    <>
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Received" value={formatDate(record.date)} width={width} />
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Role" value={record.role ? capitalize(record.role) : "Not coded"} width={width} />
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Outcome" value={record.outcomes.length > 0 ? record.outcomes.join(", ") : record.outcome ?? "Not coded"} width={width} />
      {record.manufacturer ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Labeler" value={record.manufacturer} width={width} /> : null}
      {record.reporter ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Reporter" value={record.reporter} width={width} /> : null}
      {record.country ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Country" value={record.country} width={width} /> : null}
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Report" value={record.id.slice("drug:".length)} width={width} />
      <Section title="Reactions" width={width}>
        <Prose text={record.reactions.join(", ") || "None coded."} width={width} figures={false} />
      </Section>
      <Section title="Drugs in the Report" width={width}>
        <Prose
          text={record.drugs.map((drug) => (drug.role ? `${drug.name} (${drug.role})` : drug.name)).join(", ") || "None listed."}
          width={width}
          figures={false}
        />
      </Section>
    </>
  );
}

function DeviceReportDetail({ record, width }: { record: DeviceReport; width: number }) {
  return (
    <>
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Received" value={formatDate(record.date)} width={width} />
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Event" value={record.eventType ?? "Not coded"} width={width} />
      {record.manufacturer ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Manufacturer" value={record.manufacturer} width={width} /> : null}
      {record.model ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Model" value={record.model} width={width} /> : null}
      {record.productCode ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Product code" value={record.productCode} width={width} /> : null}
      {record.reportNumber ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Report" value={record.reportNumber} width={width} /> : null}
      {record.productProblems.length > 0 ? (
        <Section title="Device Problems" width={width}>
          <Prose text={record.productProblems.join(", ")} width={width} figures={false} />
        </Section>
      ) : null}
      {record.patientProblems.length > 0 ? (
        <Section title="Patient Problems" width={width}>
          <Prose text={record.patientProblems.join(", ")} width={width} figures={false} />
        </Section>
      ) : null}
    </>
  );
}

function DrugRecallDetail({ record, width }: { record: DrugRecall; width: number }) {
  return (
    <>
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Initiated" value={formatDate(record.date)} width={width} />
      {record.reportDate ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Reported" value={formatDate(record.reportDate)} width={width} /> : null}
      <KeyValueRow labelWidth={LABEL_WIDTH} label="Class" value={record.classification ?? "Not yet classified"} width={width} />
      {record.status ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Status" value={record.status} width={width} /> : null}
      {record.recallNumber ? <KeyValueRow labelWidth={LABEL_WIDTH} label="Recall" value={record.recallNumber} width={width} /> : null}
      <Section title="Product" width={width}>
        <Prose text={record.product} width={width} figures={false} />
      </Section>
      {record.reason ? (
        <Section title="Reason" width={width}>
          <Prose text={record.reason} width={width} figures={false} />
        </Section>
      ) : null}
      {record.distribution ? (
        <Section title="Distribution" width={width}>
          <Prose text={record.distribution} width={width} figures={false} />
        </Section>
      ) : null}
    </>
  );
}

function RecordDetail({ record, width }: { record: OpenFdaRecord; width: number }): ReactNode {
  if (record.dataset === "drug") return <DrugReportDetail record={record} width={width} />;
  if (record.dataset === "device") return <DeviceReportDetail record={record} width={width} />;
  return <DrugRecallDetail record={record} width={width} />;
}

const isDataset = (value: unknown): value is OpenFdaDataset => DATASETS.some((entry) => entry.value === value);

export function OpenFdaPane({ width, height, focused }: PaneProps) {
  const client = useMemo(() => new OpenFdaClient(), []);
  const [storedQuery] = usePaneSettingValue("query", "");
  const initialQuery = String(storedQuery ?? "").trim();
  const [query, setQuery] = usePluginPaneState("query", initialQuery);
  const [storedDataset, setDataset] = usePluginPaneState<OpenFdaDataset>("dataset", "drug");
  const dataset = isDataset(storedDataset) ? storedDataset : "drug";
  const [selectedId, setSelectedId] = useDebouncedPluginPaneState<string | null>("selectedId", null);
  // The open record is what the pane shows, so a reload or a shared layout opens it again.
  const [openItemId, setOpenItemId] = usePluginPaneState<string | null>("openItemId", null);
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const term = query.trim();
  usePaneTitle(term ? `FDA ${term}` : "FDA Reports");
  // One dataset at a time, so a search sends one request and each dataset's
  // matches, failures and paging are its own.
  const loadPage = useMemo(
    () => ({ offset, signal }: PageRequest) => client.listPage(dataset, term, offset, signal),
    [client, dataset, term],
  );
  const records = usePagedRows(loadPage, { getId: (record) => record.id, keepPreviousRows: true });
  const rows = records.rows;
  const firstPage = records.pages[0] ?? null;
  const windowLimited = records.pages[records.pages.length - 1]?.windowLimited ?? false;
  const loadMore = useTableLoadMore(scrollRef, records.hasMore && !openItemId, records.loadMore);
  const columns = useMemo(() => recordColumns(dataset, width), [dataset, width]);
  const datasetLabel = DATASETS.find((entry) => entry.value === dataset)!.label;

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const openRecord = openItemId ? rows.find((row) => row.id === openItemId) ?? null : null;
  // A restored open record can sit past the first page: page on until it
  // arrives, and drop it only once every page is in without it.
  useEffect(() => {
    if (!openItemId || openRecord || records.status !== "loaded" || records.loadingMore) return;
    if (records.hasMore && !records.moreError) records.loadMore();
    else setOpenItemId(null);
  }, [openItemId, openRecord, records, setOpenItemId]);

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery.trim());
    setSelectedId(null);
    setOpenItemId(null);
  }, [setOpenItemId, setQuery, setSelectedId]);
  const updateDataset = useCallback((next: OpenFdaDataset) => {
    setDataset(next);
    setSelectedId(null);
    setOpenItemId(null);
  }, [setDataset, setOpenItemId, setSelectedId]);

  const loading = records.loading && rows.length === 0;
  const error = records.error?.message ?? null;
  usePaneRefreshKey(records.reload, { focused, enabled: !searchFocused && !openItemId });

  const linkRecord = openRecord ?? selected;
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(records.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(records.moreError ? [{ id: "more-error", parts: [{ text: records.moreError.message, tone: "warning" as const }] }] : []),
  ], [records.loadingMore, records.moreError]);
  const hints = useMemo<PaneHint[]>(
    () => (openItemId ? [] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }]),
    [focusSearch, openItemId],
  );
  usePaneStatusLinkFooter({
    registrationId: OPENFDA_PANE_ID,
    focused,
    url: linkRecord?.url ?? null,
    label: "record",
    loading: records.loading,
    error: rows.length > 0 ? error : null,
    info,
    hints,
    showOpenHint: !!linkRecord,
  });
  usePaneNoticeFooter({
    registrationId: `${OPENFDA_PANE_ID}:window`,
    notices: windowLimited ? ["FDA data pages through the first 25,050 matches. Narrow the search to reach older records."] : [],
    focused,
    enabled: !openRecord,
    title: "FDA reports",
  });

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  const renderCell = useCallback((record: OpenFdaRecord, column: RecordColumn) => cellFor(record, column.id), []);

  const lastUpdated = parseOpenFdaDate(firstPage?.lastUpdated ?? undefined);
  const figures = useMemo<StatItem[]>(() => (firstPage && firstPage.matched > 0 && !error ? [{
    id: "matched",
    label: dataset === "recall" ? "Recalls" : "Reports",
    value: firstPage.matched.toLocaleString("en-US"),
    detail: lastUpdated ? `data as of ${formatDate(lastUpdated)}` : undefined,
  }] : []), [dataset, error, firstPage, lastUpdated]);

  const header = (
    <Box flexDirection="column">
      <QueryBar
        width={width}
        search={{
          value: query,
          onChange: updateQuery,
          placeholder: "drug, device or firm",
          focused: focused && !openItemId,
          debounceMs: SEARCH_DEBOUNCE_MS,
          normalizeValue: (value) => value.trim(),
          ...searchProps,
        }}
        filters={[{
          id: "dataset",
          label: "Dataset",
          value: dataset,
          options: DATASETS,
          onChange: updateDataset,
          // Three long names fit inline only on a wide pane; narrower, a menu.
          inline: width >= 96,
        }]}
      />
      <StatGrid items={figures} width={width} />
    </Box>
  );

  if (loading || (error && rows.length === 0)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {header}
        <PaneStatusBody loading={loading} error={error} subject={datasetLabel.toLowerCase()} errorTitle={`${datasetLabel} unavailable.`} />
      </Box>
    );
  }

  const detailWidth = Math.max(0, width - 2);
  const detail = openRecord ? (
    <DetailScrollBody ref={detailScrollRef} resetScrollKey={openRecord.id}>
      <Box flexDirection="column">
        <RecordDetail record={openRecord} width={detailWidth} />
      </Box>
    </DetailScrollBody>
  ) : null;

  return (
    <DataTableStackView<OpenFdaRecord, RecordColumn>
      focused={focused && !searchFocused}
      detailOpen={!!openRecord}
      onBack={() => setOpenItemId(null)}
      detailContent={detail}
      detailTitle={openRecord ? detailTitle(openRecord) : undefined}
      detailScrollRef={detailScrollRef}
      rootBefore={header}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      getItemKey={(record) => record.id}
      renderCell={renderCell}
      selection={{
        kind: "id",
        selectedId: selected?.id ?? null,
        getId: (record) => record.id,
        onChange: (id) => setSelectedId(id),
      }}
      onActivate={(record) => setOpenItemId(record.id)}
      onRootKeyDown={handleRootKeyDown}
      sortColumnId={null}
      sortDirection="desc"
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
      selectedTextOverridesCellColor
      emptyStateTitle={term ? `No ${datasetLabel.toLowerCase()} match ${term}.` : `No ${datasetLabel.toLowerCase()}.`}
      emptyStateHint="Press / to search…"
    />
  );
}
