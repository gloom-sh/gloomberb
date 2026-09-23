import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, TeamRevisionConflictError } from "../../../api-client";
import { DataTableView } from "../../../components/data-table/view";
import { ChoiceDialog } from "../../../components/ui/choice-dialog";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { getSharedRegistry } from "../../registry";
import { runPaneTemplateDialogWizard } from "../../../app/pane-template-dialog-wizard";
import { teamPrefix } from "../cloud/team/model";
import { teamStore } from "../cloud/team/store";
import { teamViewsStore } from "../cloud/team/views";
import { setPaneSettings } from "../../../pane-settings";
import { customViewInstanceSettings } from "./index";
import type { DataTableColumn } from "../../../components/ui/data-table/types";
import { EmptyState, PaneStatusBody, usePaneFooter } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneInstance, usePaneAppConfig } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text } from "../../../ui";
import { usePluginAppActions, usePluginPaneActions } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
import { resolveEntryValue } from "../../../market-data/coordinator";
import { buildQuoteKey } from "../../../market-data/selectors";
import { useSampledValue } from "../../../state/hooks/live-ticker-financials";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { normalizeSymbol } from "../../../utils/exchanges";
import { LIVE_VIEW_ROW_LIMIT, liveViewColumns, overlayViewRow, viewRowSymbol } from "./live-quotes";
import { loadViewSource, type LoadedView } from "./loader";
import {
  applyViewProjection,
  formatViewValue,
  parseViewSpecOr,
  type ViewColumn,
  type ViewRow,
  type ViewSort,
  type ViewSpec,
} from "./view-spec";

export const CUSTOM_VIEW_PANE_ID = "custom-view";
export const CUSTOM_VIEW_SPEC_SETTING = "spec";

type Column = DataTableColumn & { key: string; transform?: ViewColumn["transform"] };

const DEFAULT_COLUMN_WIDTH = 14;
const NO_ROWS: ViewRow[] = [];
const NO_TARGETS: QuoteSubscriptionTarget[] = [];
/** Live values move every tick; filters and sort follow them at most this often. */
const LIVE_VIEW_ORDER_SAMPLE_MS = 5_000;

function viewQuoteKey(symbol: string): string {
  return buildQuoteKey({ symbol: normalizeSymbol(symbol), exchange: "", instrument: null });
}

function columnsFor(spec: ViewSpec, loaded: LoadedView | null): Column[] {
  const known = new Map((loaded?.columns ?? []).map((column) => [column.key, column]));
  const picked: ViewColumn[] = spec.projection.columns.length > 0
    ? spec.projection.columns
    : (loaded?.columns ?? []).map((column) => ({ key: column.key }));
  return picked.map((column, index) => {
    const source = known.get(column.key);
    const align = column.align ?? source?.align ?? "left";
    return {
      id: column.key,
      key: column.key,
      label: column.label ?? source?.header ?? column.key,
      align: align === "right" ? "right" : "left",
      width: column.width ?? (index === 0 ? 18 : DEFAULT_COLUMN_WIDTH),
      ...(index === 0 ? { flexGrow: 1 } : {}),
      transform: column.transform,
    };
  });
}

export function CustomViewPane({ focused, width, height }: PaneProps) {
  const instance = usePaneInstance();
  const config = usePaneAppConfig();
  const { selectTicker } = usePluginPaneActions();
  const { notify } = usePluginAppActions();
  const dialog = useDialog();
  const rawSpec = instance?.settings?.[CUSTOM_VIEW_SPEC_SETTING];
  const parsed = useMemo(() => (rawSpec ? parseViewSpecOr(rawSpec) : null), [rawSpec]);
  const spec = parsed && "spec" in parsed ? parsed.spec : null;
  const specError = parsed && "error" in parsed ? parsed.error : null;
  const [sort, setSort] = useState<ViewSort | null | undefined>(undefined);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const loader = useCallback(async () => {
    if (!spec) throw new Error(specError ?? "This view has no spec yet.");
    const controller = new AbortController();
    return loadViewSource(spec, config, controller.signal);
  }, [config, spec, specError]);
  const { data, loading, error, reload, updatedAt } = useAsyncResource(spec ? loader : null);
  useAutoRefresh(updatedAt, reload);

  useEffect(() => {
    setSort(undefined);
  }, [spec]);

  const columns = useMemo(() => (spec ? columnsFor(spec, data) : []), [data, spec]);
  const symbolKey = spec?.presentation.symbolKey ?? (columns.some((column) => column.key === "symbol") ? "symbol" : null);

  // Price, change and volume columns of rows that name a symbol stream through
  // the shared quote feed; every other column keeps the loader's refresh.
  const liveFields = useMemo(() => liveViewColumns(data?.columns ?? []), [data?.columns]);
  const sourceRows = data?.rows ?? NO_ROWS;
  const loadedRows = useMemo(
    () => (spec && data ? applyViewProjection(data.rows, spec.projection, sort) : NO_ROWS),
    [data, sort, spec],
  );
  const streamBlock = Math.max(10, height);
  const streamWindowStart = Math.max(0, (Math.floor(selectedIndex / streamBlock) - 1) * streamBlock);
  const quoteTargets = useMemo<QuoteSubscriptionTarget[]>(() => {
    if (liveFields.size === 0 || !symbolKey) return NO_TARGETS;
    const targets: QuoteSubscriptionTarget[] = [];
    loadedRows.slice(0, LIVE_VIEW_ROW_LIMIT).forEach((row, index) => {
      const symbol = viewRowSymbol(row, symbolKey);
      if (!symbol) return;
      const visible = index >= streamWindowStart && index < streamWindowStart + streamBlock * 3;
      targets.push({ symbol, exchange: "", surface: "screener", visible, weight: visible ? 60 : 20 });
    });
    return targets;
  }, [liveFields, loadedRows, streamBlock, streamWindowStart, symbolKey]);
  const { entries: liveQuotes } = useLiveQuoteEntries(quoteTargets);
  const liveRows = useMemo(() => {
    if (quoteTargets.length === 0) return sourceRows;
    return sourceRows.map((row) => {
      const symbol = viewRowSymbol(row, symbolKey);
      const entry = symbol ? liveQuotes.get(viewQuoteKey(symbol)) : undefined;
      return overlayViewRow(row, entry ? resolveEntryValue(entry) : null, liveFields);
    });
  }, [liveFields, liveQuotes, quoteTargets.length, sourceRows, symbolKey]);
  // Filtering and sorting on live values at tick speed would shuffle rows
  // under the cursor, so the order follows sampled values instead.
  const orderInput = useSampledValue(
    liveRows,
    LIVE_VIEW_ORDER_SAMPLE_MS,
    `${updatedAt ?? ""}:${sort ? `${sort.by}:${sort.direction}` : String(sort)}`,
  );
  const rows = useMemo(() => {
    if (!spec || !data) return NO_ROWS;
    const ordered = applyViewProjection(orderInput, spec.projection, sort);
    if (orderInput === liveRows) return ordered;
    const indexOf = new Map(orderInput.map((row, index) => [row, index]));
    return ordered.map((row) => liveRows[indexOf.get(row) ?? -1] ?? row);
  }, [data, liveRows, orderInput, sort, spec]);
  const baseByColumn = useMemo(() => {
    const bases = new Map<string, number>();
    for (const column of columns) {
      if (column.transform !== "index100") continue;
      const first = rows.find((row) => typeof row[column.key] === "number")?.[column.key];
      if (typeof first === "number") bases.set(column.key, first);
    }
    return bases;
  }, [columns, rows]);
  const activeSort = sort === undefined ? spec?.projection.sort ?? null : sort;
  // Memoized so the table's row memo holds while the selection moves.
  const rowKey = useCallback((row: ViewRow, index: number) => (
    `${symbolKey && typeof row[symbolKey] === "string" ? row[symbolKey] : ""}:${index}`
  ), [symbolKey]);
  const renderRowCell = useCallback((row: ViewRow, column: Column) => ({
    text: formatViewValue(row[column.key], column.transform, baseByColumn.get(column.key)),
    color: column.key === symbolKey ? colors.textBright : undefined,
  }), [baseByColumn, symbolKey]);

  /**
   * Publishes this view to a team. An inline view becomes a new team view
   * and this pane starts following it; a view that already follows a team
   * view pushes a revision with If-Match and asks on conflict.
   */
  const publishToTeam = useCallback(async () => {
    if (!spec || !instance) return;
    const teams = teamStore.getSnapshot().teams;
    if (teams.length === 0) {
      notify({ body: "Join or create a team first with TEAM.", type: "info" });
      return;
    }
    try {
      if (spec.source.kind === "ref") {
        const current = teamViewsStore.get(spec.source.viewId) ?? (await apiClient.getTeamView(spec.source.viewId));
        if (!current) throw new Error("This team view no longer exists.");
        const currentParsed = parseViewSpecOr(current.spec);
        const values = await runPaneTemplateDialogWizard(dialog, [{
          key: "spec",
          label: `Publish a revision of ${current.name}`,
          type: "textarea",
          defaultValue: JSON.stringify("spec" in currentParsed ? currentParsed.spec : current.spec, null, 2),
          body: [`Edit the spec, or ask Gloom to. Enter publishes r${current.revision + 1}.`],
        }]);
        const edited = values?.spec ? parseViewSpecOr(values.spec) : null;
        if (!edited) return;
        if ("error" in edited) throw new Error(edited.error);
        try {
          const published = await apiClient.publishTeamViewRevision(current.id, {
            spec: edited.spec as unknown as Record<string, unknown>,
            expectedRevision: current.revision,
          });
          teamViewsStore.upsert(published);
          notify({ body: `Published ${published.name} r${published.revision}.`, type: "success" });
          void reload();
        } catch (error) {
          if (!(error instanceof TeamRevisionConflictError)) throw error;
          const choice = await dialog.prompt<string>({
            closeOnClickOutside: false,
            content: (context: PromptContext<string>) => (
              <ChoiceDialog
                {...context}
                title={`A teammate published r${error.currentRevision} first`}
                choices={[
                  { id: "overwrite", label: "Overwrite with mine", description: `Publishes yours as r${error.currentRevision + 1}.` },
                  { id: "reload", label: "Take theirs", description: "This pane follows their revision." },
                ]}
                selectedChoiceId="reload"
              />
            ),
          }).catch(() => undefined);
          if (choice === "overwrite") {
            const published = await apiClient.publishTeamViewRevision(current.id, {
              spec: edited.spec as unknown as Record<string, unknown>,
              expectedRevision: error.currentRevision,
            });
            teamViewsStore.upsert(published);
            notify({ body: `Published ${published.name} r${published.revision}.`, type: "success" });
          }
          void reload();
        }
        return;
      }

      const defaultTeam = teamStore.getDefaultTeamId();
      const teamId = teams.length === 1
        ? teams[0]!.id
        : await dialog.prompt<string>({
          closeOnClickOutside: true,
          content: (context: PromptContext<string>) => (
            <ChoiceDialog
              {...context}
              title="Publish this view to"
              choices={teams.map((team) => ({ id: team.id, label: `${teamPrefix(team)} ${team.name}` }))}
              selectedChoiceId={defaultTeam ?? undefined}
            />
          ),
        }).catch(() => undefined);
      if (!teamId) return;
      const values = await runPaneTemplateDialogWizard(dialog, [{
        key: "name",
        label: "View name",
        type: "text",
        defaultValue: instance.title ?? spec.presentation.title ?? "",
        placeholder: "Top movers",
      }]);
      if (!values?.name) return;
      const created = await apiClient.createTeamView(teamId, {
        name: values.name,
        spec: { ...spec, presentation: { ...spec.presentation, title: values.name } } as unknown as Record<string, unknown>,
      });
      teamViewsStore.upsert(created);
      // This pane now follows the team view, so a teammate's revision reaches it.
      const registry = getSharedRegistry();
      if (registry) {
        const following: ViewSpec = {
          version: 1,
          source: { kind: "ref", viewId: created.id, teamId },
          projection: { columns: [], filters: [] },
          presentation: { title: values.name },
        };
        registry.updateLayoutFn(setPaneSettings(registry.getLayoutFn(), instance.instanceId, {
          ...instance.settings,
          ...customViewInstanceSettings(following),
        }));
      }
      const team = teams.find((entry) => entry.id === teamId);
      notify({ body: `Published "${values.name}" to ${team?.name ?? "the team"}. Members find it as ${team ? teamPrefix(team) : ""} ${values.name}.`, type: "success" });
    } catch (error) {
      notify({ body: error instanceof Error ? error.message : "Could not publish the view.", type: "error" });
    }
  }, [dialog, instance, notify, reload, spec]);

  useShortcut((event) => {
    if (!focused) return;
    if (event.name === "r" && !event.ctrl && !event.meta) {
      event.preventDefault?.();
      void reload();
    } else if (event.name === "t" && !event.ctrl && !event.meta && spec) {
      event.preventDefault?.();
      void publishToTeam();
    }
  });

  // The source is fixed for the life of the view and the table shows its
  // rows, so the footer carries only the current failure. `r` is global.
  usePaneFooter(CUSTOM_VIEW_PANE_ID, () => ({
    info: data?.errors.length ? [{ id: "errors", parts: [{ text: data.errors[0]!, tone: "warning" as const }] }] : [],
    hints: spec
      ? [{ id: "team", key: "t", label: spec.source.kind === "ref" ? "eam revision" : "eam publish", onPress: () => { void publishToTeam(); } }]
      : [],
  }), [data?.errors, publishToTeam, spec]);

  if (!spec) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState
          status={specError ? "error" : "empty"}
          title={specError ? "This view's spec is invalid." : "This view is empty."}
          message={specError ?? "Ask Gloom to build one: \"make a view of the top S&P movers sorted by change\"."}
          hint="A view is a data function plus columns, a filter, and a sort. Publish it to a team from the gallery."
        />
      </Box>
    );
  }

  if (loading && !data) {
    return <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading view..." />;
  }
  if (error && !data) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState status="error" title="This view could not load." message={error} hint="r to retry" />
      </Box>
    );
  }
  if (rows.length === 0) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState title="No rows match this view." message={data?.errors[0]} />
        {spec.presentation.title ? <Text fg={colors.textDim}>{spec.presentation.title}</Text> : null}
      </Box>
    );
  }

  return (
    <DataTableView<ViewRow, Column>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      selection={{
        kind: "index",
        selectedIndex,
        onChange: (index) => setSelectedIndex(index),
      }}
      columns={columns}
      items={rows}
      sortColumnId={activeSort?.by ?? null}
      sortDirection={activeSort?.direction ?? "desc"}
      onHeaderClick={(id) => setSort((current) => {
        const active = current === undefined ? spec.projection.sort ?? null : current;
        return active?.by === id
          ? { by: id, direction: active.direction === "desc" ? "asc" : "desc" }
          : { by: id, direction: "desc" };
      })}
      getItemKey={rowKey}
      renderCell={renderRowCell}
      onActivate={(row) => {
        const symbol = symbolKey ? row[symbolKey] : null;
        if (typeof symbol === "string" && symbol) selectTicker(symbol);
      }}
      emptyStateTitle="No rows."
    />
  );
}
