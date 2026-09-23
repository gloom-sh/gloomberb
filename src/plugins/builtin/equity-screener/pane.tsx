import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  ScrollBox,
  useRendererHost,
  type ScrollBoxRenderable,
} from "../../../ui";
import {
  Button,
  ConfirmDialog,
  DataTableStackView,
  DataTableView,
  KeyValueRow,
  Notice,
  PageStackView,
  PaneStatusBody,
  QueryBar,
  Tabs,
  usePaneHeaderTabs,
  TextField,
  usePaneFooter,
  usePaneNoticeFooter,
  useTableLoadMore,
  type DataTableColumn,
  type DataTableVisibleRange,
  type SelectControl,
} from "../../../components";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginAppActions,
  usePluginPaneState,
  useShortcut,
} from "../../../public/react";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { useThemeColors } from "../../../theme/theme-context";
import { apiClient } from "../../../api-client";
import {
  NUMERIC_FIELDS,
  type NumericField,
  type ScreenDefinition,
  type ScreenField,
  type ScreenRow,
} from "../../../api-client/equity-screener";
import type { PaneProps } from "../../../types/plugin";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { usePlanAccess } from "../shared/plan-access";
import { SignInWall } from "../cloud/auth-actions";
import { CriterionEditor } from "./criterion-editor";
import {
  fetchSavedScreens,
  fetchScreenFields,
  screenerApi,
  validateSavedScreen,
} from "./client";
import {
  columnWidth,
  criterionText,
  DEFAULT_SCREEN,
  formatScreenValue,
  metricDate,
  parseScreenDefinition,
  resultFields,
  SHORT_LABELS,
  screenLabel,
  screenRowId,
} from "./model";
import { useScreenResults } from "./results";
import { overlayLiveScreenRows } from "./live";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { buildScreenerQuoteTargets } from "../shared/screener-live-quotes";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { getTableWidth } from "../../../components/ui/table-layout";

/** Rows streamed beyond the visible window so a short scroll lands on live prices. */
const STREAM_OVERSCAN = 8;
/** Before the table reports its window, stream what a full-height pane shows. */
const INITIAL_STREAM_ROWS = 40;

const TABS = [
  { value: "results", label: "Results" },
  { value: "criteria", label: "Criteria" },
  { value: "saved", label: "Saved" },
];
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";
const date = (value: string | null) => value?.slice(0, 10) ?? "--";
const rank = (value: number | null) =>
  value == null ? "--" : value.toFixed(0);

/**
 * Symbol and name, then the focus metric with its covered-universe percentile
 * and date, then the screen's criteria and context metrics as width allows.
 */
function resultColumns(
  width: number,
  definition: ScreenDefinition,
  metric: NumericField,
): DataTableColumn[] {
  const [focus, ...others] = resultFields(definition, metric);
  const metricColumn = (field: NumericField): DataTableColumn => ({
    id: `m:${field}`,
    label: SHORT_LABELS[field],
    width: columnWidth(field),
    align: "right",
  });
  const build = (
    extra: DataTableColumn[],
    exchange: boolean,
    sector: boolean,
  ): DataTableColumn[] => [
    { id: "symbol", label: "SYMBOL", width: 8, align: "left" },
    { id: "name", label: "NAME", width: 18, flexGrow: 1, align: "left" },
    ...(exchange ? [{ id: "exchange", label: "EXCH", width: 7, align: "left" as const }] : []),
    ...(sector ? [{ id: "sector", label: "SECTOR", width: 22, align: "left" as const }] : []),
    metricColumn(focus!),
    { id: "percentile", label: "PCTL", width: 4, align: "right" },
    { id: "date", label: "AS OF", width: 10, align: "left" },
    ...extra,
  ];
  // Measured the way the table draws them (header floor, gaps, lead gaps), so a
  // column is only added when it fits whole.
  const fits = (columns: DataTableColumn[]) => getTableWidth(columns) <= width;
  let shown: DataTableColumn[] = [];
  for (const field of others) {
    const next = [...shown, metricColumn(field)];
    if (!fits(build(next, false, false))) break;
    shown = next;
  }
  const exchange = fits(build(shown, true, false));
  const sector = exchange && fits(build(shown, true, true));
  return build(shown, exchange, sector);
}
const loadFields = () => fetchScreenFields();
function ScreenDetail({
  row,
  width,
  height,
}: {
  row: ScreenRow;
  width: number;
  height: number;
}) {
  return (
    <ScrollBox width={width} height={height} scrollY>
      <Box paddingX={1} flexDirection="column">
        <KeyValueRow
          label="Listing"
          value={`${row.symbol}:${row.exchange}`}
          detail={[row.currency, row.sector, row.industry].filter(Boolean).join(" \u00b7 ") || "--"}
        />
        {NUMERIC_FIELDS.map((field) => {
          const metric = row.metrics[field];
          const stamp = metricDate(metric);
          return (
            <KeyValueRow
              key={field}
              label={screenLabel(field)}
              labelWidth={24}
              value={`${formatScreenValue(field, metric.value)} ${metric.unit}`}
              detail={
                metric.value === null
                  ? (metric.reason ?? "unavailable")
                  : [
                      metric.percentile.value == null ? null : `${rank(metric.percentile.value)} pctl`,
                      stamp.collected ? `collected ${stamp.text}` : stamp.text,
                      metric.state === "available" ? null : metric.state,
                    ].filter(Boolean).join(" \u00b7 ")
              }
            />
          );
        })}
      </Box>
    </ScrollBox>
  );
}
export function EquityScreenerPane(props: PaneProps) {
  const session = useResearchCloudSession();
  const [seed] = usePaneSettingValue<string | undefined>(
    "definition",
    undefined,
  );
  let initial: ScreenDefinition;
  try {
    initial = seed ? parseScreenDefinition(JSON.parse(seed)) : DEFAULT_SCREEN;
  } catch (error) {
    return (
      <PaneStatusBody subject="screen definition" error={errorText(error)} />
    );
  }
  return (
    <EquityScreenView
      key={`${seed ?? "default"}:${session.requestKey}`}
      {...props}
      initial={initial}
    />
  );
}
function EquityScreenView({
  width,
  height,
  focused,
  initial,
}: PaneProps & { initial: ScreenDefinition }) {
  const colors = useThemeColors(),
    dialog = useDialog(),
    host = useRendererHost();
  const { notify, createPaneFromTemplate } = usePluginAppActions();
  const session = useResearchCloudSession(),
    access = usePlanAccess();
  const [definition, setDefinition] = usePluginPaneState("definition", initial);
  const [metric, setMetric] = usePaneSettingValue<NumericField>(
    "metric",
    "marketCap",
  );
  const [mode, setMode] = usePluginPaneState("mode", "results");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(
    "selected",
    null,
  );
  const [openId, setOpenId] = usePluginPaneState<string | null>("open", null);
  const [selectedCriterion, setSelectedCriterion] = usePluginPaneState(
    "criterion",
    "0",
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [savedSelectedId, setSavedSelectedId] = usePluginPaneState<
    string | null
  >("savedSelected", null);
  const [currentSavedId, setCurrentSavedId] = usePluginPaneState<string | null>(
    "currentSaved",
    null,
  );
  const [saving, setSaving] = useState(false),
    [exporting, setExporting] = useState(false);
  const [saveFocus, setSaveFocus] = useState("name");
  const [saveForm, setSaveForm] = useState(false),
    [name, setName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const fields = useAsyncResource(loadFields);
  const savedLoader = useCallback(
    () => fetchSavedScreens(),
    [session.requestKey],
  );
  const saved = useAsyncResource(
    access.emailVerified && (mode === "saved" || saveForm) ? savedLoader : null,
  );
  const results = useScreenResults(definition, session.requestKey);
  const data = results.data;
  const snapshotRows = data?.rows ?? [];
  // Price, change, volume and market cap stream for the rows on screen; the
  // screen itself (membership, order, percentiles) stays the snapshot's.
  const liveStreaming = useLiveStreamingSetting();
  const [visibleRange, setVisibleRange] = useState<DataTableVisibleRange>({ start: 0, end: INITIAL_STREAM_ROWS });
  const streamTargets = useMemo(() => {
    const onScreen = snapshotRows.slice(Math.max(0, visibleRange.start - STREAM_OVERSCAN), visibleRange.end + STREAM_OVERSCAN);
    const selectedRow = snapshotRows.find((row) => screenRowId(row) === selectedId);
    const streamed = selectedRow && !onScreen.includes(selectedRow) ? [...onScreen, selectedRow] : onScreen;
    const selectedTarget = selectedRow ? selectedRow.symbol : null;
    return buildScreenerQuoteTargets(streamed, selectedTarget);
  }, [selectedId, snapshotRows, visibleRange]);
  const { entries: liveEntries } = useLiveQuoteEntries(streamTargets, {
    freshnessScopeKey: `equity-screener:${JSON.stringify(definition)}`,
    liveStreaming,
  });
  const rows = useMemo(() => overlayLiveScreenRows(snapshotRows, liveEntries), [liveEntries, snapshotRows]);
  const opened = rows.find((row) => screenRowId(row) === openId);
  const selected =
    opened ?? rows.find((row) => screenRowId(row) === selectedId) ?? rows[0];
  const currentSaved = saved.data?.find((row) => row.id === currentSavedId);
  const selectedSaved =
    saved.data?.find((row) => row.id === savedSelectedId) ?? saved.data?.[0];
  useEffect(() => {
    if (
      openId &&
      data &&
      !opened &&
      data.nextCursor &&
      !results.loading &&
      !results.loadingMore
    )
      void results.loadMore();
  }, [
    openId,
    data,
    opened,
    results.loading,
    results.loadingMore,
    results.loadMore,
  ]);
  const tableScroll = useRef<ScrollBoxRenderable>(null);
  const queryControl = useRef<SelectControl>(null);
  const loadMore = useTableLoadMore(
    tableScroll,
    !opened && !results.loading && !results.loadingMore && !!data?.nextCursor,
    results.loadMore,
  );
  const metricFields =
    fields.data?.fields.filter((field) => field.kind === "number") ?? [];
  const columns = resultColumns(width, definition, metric);
  const apply = (next: ScreenDefinition) => {
    try {
      setDefinition(parseScreenDefinition(next));
      setOpenId(null);
      setActionError(null);
    } catch (error) {
      setActionError(errorText(error));
    }
  };
  const switchMode = (next: string) => {
    setMode(next);
    setEditing(null);
    setSaveForm(false);
    setActionError(null);
  };
  const research = () => {
    if (selected)
      createPaneFromTemplate("new-ticker-detail-pane", {
        symbol: selected.symbol,
        listing: {
          name: selected.name ?? selected.symbol,
          exchange: selected.exchange,
          currency: selected.currency ?? "",
          type: "STK",
        },
      });
  };
  const startSave = () => {
    if (!access.emailVerified) { switchMode("saved"); return; }
    setName(currentSaved?.name ?? "");
    setSaveForm(true);
    setSaveFocus("name");
    setActionError(null);
  };
  const save = async (copy = false) => {
    if (saving || !name.trim()) return;
    setSaving(true);
    setActionError(null);
    const requestSession = session.requestKey;
    try {
      const entry = validateSavedScreen(
        currentSaved && !copy
          ? await screenerApi.update(
              currentSaved.id,
              currentSaved.revision,
              name.trim(),
              definition,
            )
          : await screenerApi.create(
              name.trim(),
              definition,
            ),
      );
      if (
        requestSession !==
        JSON.stringify([
          apiClient.getCurrentUser()?.id ?? null,
          access.emailVerified,
        ])
      )
        return;
      setCurrentSavedId(entry.id);
      setSavedSelectedId(entry.id);
      setSaveForm(false);
      setMode("saved");
      await saved.reload();
      notify({ body: `Saved ${entry.name}`, type: "success" });
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  const removeSaved = async () => {
    const entry = selectedSaved;
    if (!entry || saving) return;
    const confirmed = await dialog
      .prompt<boolean>({
        content: (context: PromptContext<boolean>) => (
          <ConfirmDialog
            {...context}
            title="Delete saved screen?"
            body={[entry.name]}
            confirmLabel="Delete"
          />
        ),
      })
      .catch(() => false);
    if (!confirmed) return;
    setSaving(true);
    try {
      await screenerApi.remove(entry.id, entry.revision);
      await saved.reload();
      if (currentSavedId === entry.id) setCurrentSavedId(null);
      notify({ body: "Screen deleted", type: "success" });
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  const exportAll = async () => {
    if (!data?.snapshot || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      if (!host.saveTextFile)
        throw new Error("File export is unavailable in this renderer.");
      const file = await screenerApi.export(
        data.definition,
        data.snapshot.id,
      );
      if (file.snapshotId !== data.snapshot.id || typeof file.csv !== "string")
        throw new Error("Export snapshot did not match the displayed screen.");
      const location = await host.saveTextFile({
        name: file.filename,
        text: file.csv,
        mimeType: "text/csv",
      });
      notify({ body: `Exported ${location}`, type: "success" });
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setExporting(false);
    }
  };
  useAutoRefresh(results.updatedAt, results.load);
  const hints =
    saveForm || editing !== null
      ? []
      : mode === "criteria"
        ? [
            {
              id: "add",
              key: "a",
              label: "dd criterion",
              onPress: () => setEditing(-1),
              disabled: !fields.data || definition.criteria.length >= 20,
            },
            {
              id: "remove",
              key: "d",
              label: "elete criterion",
              onPress: () =>
                apply({
                  ...definition,
                  criteria: definition.criteria.filter(
                    (_, index) => index !== Number(selectedCriterion),
                  ),
                }),
              disabled: !definition.criteria.length,
            },
          ]
        : mode === "saved"
          ? [
              {
                id: "delete",
                key: "d",
                label: "elete",
                onPress: () => {
                  void removeSaved();
                },
                disabled: !selectedSaved || saving,
              },
            ]
          : [
              { id: "save", key: "s", label: "ave screen", onPress: startSave },
              {
                id: "export",
                key: "x",
                label: "port all",
                onPress: () => {
                  void exportAll();
                },
                disabled: !data?.snapshot || exporting,
              },
              {
                id: "research",
                key: "o",
                label: "pen research",
                onPress: research,
                disabled: !selected,
              },
            ];
  usePaneFooter(
    "equity-screener",
    () => ({
      info: [
        ...(results.loading || results.loadingMore
          ? [
              {
                id: "loading",
                parts: [
                  {
                    text: results.loadingMore
                      ? "loading more"
                      : "loading screen",
                    tone: "muted" as const,
                  },
                ],
              },
            ]
          : []),
        ...(data?.snapshot
          ? [
              {
                id: "asof",
                parts: [
                  {
                    text: `${data.universe.matched.toLocaleString("en-US")} of ${data.universe.covered.toLocaleString("en-US")} covered`,
                  },
                  {
                    text: `· ${data.definition.currency ?? "native currencies"} · snapshot ${data.snapshot.assembledAt.slice(0, 16).replace("T", " ")} UTC`,
                    tone: "muted" as const,
                  },
                ],
              },
            ]
          : []),
        ...(saving || exporting
          ? [
              {
                id: "busy",
                parts: [
                  {
                    text: saving ? "saving" : "exporting",
                    tone: "muted" as const,
                  },
                ],
              },
            ]
          : []),
      ],
      hints,
    }),
    [
      results.loading,
      results.loadingMore,
      data,
      saving,
      exporting,
      hints,
    ],
  );
  usePaneNoticeFooter({
    registrationId: "equity-screener:notices",
    focused,
    notices: [
      ...(data?.warnings ?? []),
      ...(opened?.warnings ?? []),
      ...[
        results.error,
        fields.error,
        mode === "saved" ? saved.error : null,
        actionError,
      ].filter((value): value is string => !!value),
    ],
  });
  useShortcut(
    (event) => {
      if (!saveForm) return;
      const ring = [
        "name",
        "save",
        ...(currentSaved ? ["copy"] : []),
        "cancel",
      ];
      if (event.name === "tab") {
        event.preventDefault();
        event.stopPropagation();
        setSaveFocus((current) => ring[(ring.indexOf(current) + (event.shift ? -1 : 1) + ring.length) % ring.length]!);
      } else if (event.name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        setSaveForm(false);
      } else if (
        ["enter", "return"].includes(event.name ?? "") &&
        !event.targetEditable
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (saveFocus === "cancel") setSaveForm(false);
        else void save(saveFocus === "copy");
      }
    },
    {
      enabled: focused && saveForm,
      allowEditable: true,
      phase: "before",
      scope: "equity-screen-save",
    },
  );
  useShortcut((event) => {
    if (
      !focused ||
      event.targetEditable ||
      event.ctrl ||
      event.meta ||
      editing !== null
    )
      return;
    if (saveForm) {
      if (event.name === "escape") {
        event.preventDefault();
        setSaveForm(false);
      }
      return;
    }
    if (event.name === "tab" && mode !== "saved" && !opened) {
      event.preventDefault();
      queryControl.current?.open();
      return;
    }
    if (event.name === "r") {
      event.preventDefault();
      void results.load();
      if (mode === "saved") void saved.reload();
      return;
    }
    const hint = hints.find(
      (hint) => hint.key === event.name && !hint.disabled,
    );
    if (hint) {
      event.preventDefault();
      hint.onPress();
    }
  });
  const tabsInHeader = usePaneHeaderTabs({
    tabs: TABS,
    activeValue: mode,
    onSelect: switchMode,
    focused: focused && !saveForm && editing === null,
  });
  const bodyHeight = Math.max(5, height - 1 - (tabsInHeader ? 0 : 1));
  const saveContent = !access.emailVerified ? (
    <SignInWall
      action="save and open your screens"
      needsVerification={session.needsVerification}
    />
  ) : (
    <Box paddingX={1} paddingTop={1} flexDirection="column" gap={1}>
      <TextField
        label="Screen name"
        value={name}
        onChange={setName}
        onSubmit={() => {
          void save();
        }}
        focused={focused && saveFocus === "name"}
        onMouseDown={() => setSaveFocus("name")}
        width={Math.min(45, width - 4)}
      />
      {actionError ? (
        <Notice tone="negative">{actionError}</Notice>
      ) : null}
      <Box flexDirection="row" gap={1}>
        <Button
          label={currentSaved ? "Update screen" : "Save screen"}
          variant="primary"
          active={focused && saveFocus === "save"}
          disabled={saving || !name.trim()}
          onPress={() => {
            void save();
          }}
        />
        {currentSaved ? (
          <Button
            label="Save copy"
            variant="secondary"
            active={focused && saveFocus === "copy"}
            disabled={saving || !name.trim()}
            onPress={() => {
              void save(true);
            }}
          />
        ) : null}
        <Button
          label="Cancel"
          variant="secondary"
          active={focused && saveFocus === "cancel"}
          onPress={() => setSaveForm(false)}
        />
      </Box>
    </Box>
  );
  const editingCriterion =
    editing !== null && editing >= 0 ? definition.criteria[editing] : undefined;
  const body =
    mode === "criteria" ? (
      <PaneStatusBody
        loading={fields.loading && !fields.data}
        error={!fields.data ? fields.error : null}
        subject="screen fields"
      >
        {fields.data ? (
          <PageStackView
            focused={focused && !saveForm}
            detailOpen={editing !== null}
            onBack={() => setEditing(null)}
            detailTitle={
              editingCriterion ? criterionText(editingCriterion) : "New criterion"
            }
            detailContent={
              editing !== null ? (
                <CriterionEditor
                  key={editing}
                  fields={fields.data.fields}
                  value={editingCriterion ?? null}
                  focused={focused}
                  width={width}
                  onCancel={() => setEditing(null)}
                  onSave={(criterion) => {
                    const criteria = [...definition.criteria];
                    if (editing < 0) criteria.push(criterion);
                    else criteria[editing] = criterion;
                    apply({ ...definition, criteria });
                    setEditing(null);
                  }}
                />
              ) : null
            }
            rootContent={
              <>
                <QueryBar
                  width={width}
                  filters={[{
                    id: "currency",
                    label: "Currency",
                    controlRef: queryControl,
                    value: definition.currency ?? "all",
                    defaultValue: "all",
                    options: [
                      { value: "all", label: "All currencies" },
                      ...[
                        ...new Set([
                          definition.currency ?? "USD",
                          "USD",
                          "EUR",
                          "GBP",
                          "JPY",
                          ...(data?.universe.currencies ?? []),
                        ]),
                      ].map((value) => ({ value, label: value })),
                    ],
                    onChange: (value: string) =>
                      apply({
                        ...definition,
                        currency: value === "all" ? null : value,
                      }),
                  }]}
                />
                <DataTableView
                  columns={[
                    {
                      id: "criterion",
                      label: "CRITERION",
                      width: 20,
                      flexGrow: 1,
                      align: "left",
                    },
                  ]}
                  items={definition.criteria.map((criterion, index) => ({
                    id: String(index),
                    criterion,
                  }))}
                  focused={focused && editing === null && !saveForm}
                  rootWidth={width}
                  rootHeight={bodyHeight - 1}
                  getItemKey={(row) => row.id}
                  selection={{
                    kind: "id",
                    selectedId: selectedCriterion,
                    getId: (row) => row.id,
                    onChange: setSelectedCriterion,
                  }}
                  onActivate={(row) => setEditing(Number(row.id))}
                  renderCell={(row) => ({ text: criterionText(row.criterion) })}
                  sortColumnId={null}
                  sortDirection="asc"
                  emptyStateTitle="No criteria. All covered equities match."
                />
              </>
            }
          />
        ) : null}
      </PaneStatusBody>
    ) : mode === "saved" ? (
      !access.emailVerified ? (
        <SignInWall
          action="save and open your screens"
          needsVerification={session.needsVerification}
        />
      ) : (
        <PaneStatusBody
          loading={saved.loading && !saved.data}
          error={!saved.data ? saved.error : null}
          subject="saved screens"
        >
          <DataTableView
            columns={[
              { id: "name", label: "SCREEN", width: 28, align: "left" },
              {
                id: "criteria",
                label: "CRITERIA",
                width: 20,
                flexGrow: 1,
                align: "left",
              },
              { id: "updatedAt", label: "UPDATED", width: 11, align: "left" },
            ]}
            items={saved.data ?? []}
            focused={focused && !saveForm}
            rootWidth={width}
            rootHeight={bodyHeight}
            getItemKey={(row) => row.id}
            selection={{
              kind: "id",
              selectedId: selectedSaved?.id ?? null,
              getId: (row) => row.id,
              onChange: setSavedSelectedId,
            }}
            onActivate={(row) => {
              apply(row.definition);
              setCurrentSavedId(row.id);
              setMode("results");
            }}
            renderCell={(row, column) => ({
              text:
                column.id === "name"
                  ? row.name
                  : column.id === "updatedAt"
                    ? date(row.updatedAt)
                    : row.definition.criteria.map(criterionText).join("; "),
            })}
            sortColumnId={null}
            sortDirection="asc"
            emptyStateTitle="No saved screens."
          />
        </PaneStatusBody>
      )
    ) : (
      <PaneStatusBody
        loading={results.loading && !data}
        error={!data ? results.error : null}
        subject="equity screen"
      >
        {!opened ? (
          <QueryBar
            width={width}
            filters={[{
              id: "metric",
              label: "Metric",
              controlRef: queryControl,
              value: metric,
              options: metricFields.length
                ? metricFields.map((field) => ({
                    value: field.id as NumericField,
                    label: field.label,
                  }))
                : [{ value: metric, label: screenLabel(metric) }],
              onChange: (value: string) => {
                setMetric(value as NumericField);
                apply({
                  ...definition,
                  sort: { field: value as NumericField, direction: "desc" },
                });
              },
            }]}
          />
        ) : null}
        <DataTableStackView
          columns={columns}
          items={rows}
          focused={focused && !saveForm}
          rootWidth={width}
          rootHeight={bodyHeight - 1}
          scrollRef={tableScroll}
          onBodyScrollActivity={loadMore}
          resetScrollKey={JSON.stringify(definition)}
          visibleRangeKey={JSON.stringify(definition)}
          onVisibleRangeChange={setVisibleRange}
          getItemKey={screenRowId}
          selection={{
            kind: "id",
            selectedId: selectedId ?? (rows[0] ? screenRowId(rows[0]) : null),
            getId: screenRowId,
            onChange: setSelectedId,
          }}
          onActivate={(row) => setOpenId(screenRowId(row))}
          detailOpen={!!opened}
          onBack={() => setOpenId(null)}
          detailTitle={opened?.name ?? opened?.symbol}
          detailContent={
            opened ? (
              <ScreenDetail
                row={opened}
                width={width}
                height={bodyHeight - 2}
              />
            ) : null
          }
          renderCell={(row, column) => {
            const field = column.id.startsWith("m:")
              ? (column.id.slice(2) as NumericField)
              : null;
            if (field) {
              const observation = row.metrics[field];
              return {
                text: formatScreenValue(field, observation.value),
                color: observation.state === "stale" ? colors.warning : undefined,
              };
            }
            const focus = row.metrics[metric];
            if (column.id === "percentile")
              return { text: rank(focus.percentile.value) };
            if (column.id === "date") {
              const stamp = metricDate(focus);
              return {
                text: stamp.text,
                color:
                  focus.state === "stale"
                    ? colors.warning
                    : stamp.collected
                      ? colors.textMuted
                      : undefined,
              };
            }
            if (column.id === "name")
              return { text: row.name?.toUpperCase() ?? "--" };
            return { text: String(row[column.id as "symbol"] ?? "--") };
          }}
          sortColumnId={
            (NUMERIC_FIELDS as readonly string[]).includes(definition.sort.field)
              ? `m:${definition.sort.field}`
              : definition.sort.field
          }
          sortDirection={definition.sort.direction}
          onHeaderClick={(id) => {
            const field = id.startsWith("m:")
              ? (id.slice(2) as NumericField)
              : id === "percentile" || id === "date"
                ? metric
                : ["symbol", "sector", "exchange"].includes(id)
                  ? (id as ScreenField)
                  : null;
            if (!field) return;
            if ((NUMERIC_FIELDS as readonly string[]).includes(field))
              setMetric(field as NumericField);
            apply({
              ...definition,
              sort: {
                field,
                direction:
                  definition.sort.field === field &&
                  definition.sort.direction === "desc"
                    ? "asc"
                    : "desc",
              },
            });
          }}
          emptyStateTitle="No equities match this screen."
        />
      </PaneStatusBody>
    );
  return (
    <Box width={width} height={height} flexDirection="column">
      {!tabsInHeader && (
        <Tabs
          tabs={TABS}
          activeValue={mode}
          onSelect={switchMode}
          focused={focused && !saveForm && editing === null}
          dense
        />
      )}
      <PageStackView
        focused={focused}
        detailOpen={saveForm}
        onBack={() => setSaveForm(false)}
        detailTitle="Save screen"
        rootContent={body}
        detailContent={saveForm ? saveContent : null}
      />
    </Box>
  );
}
