import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, TeamRevisionConflictError } from "../../../api-client";
import { DataTableView } from "../../../components/data-table/view";
import { ChoiceDialog } from "../../../components/ui/choice-dialog";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { getSharedRegistry } from "../../registry";
import { teamPrefix } from "../../../team/model";
import { teamStore } from "../../../team/store";
import { teamViewsStore } from "../cloud/team/views";
import { setPaneSettings } from "../../../pane-settings";
import { customViewInstanceSettings } from "./index";
import { PaneStatusBody, TextPromptDialog, usePaneFooter } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { logFailure } from "../../../utils/log-failure";
import { usePaneInstance, usePaneAppConfig } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { usePluginAppActions, usePluginPaneActions } from "../../runtime";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import { buildQuoteKey } from "../../../market-data/selectors";
import { useSampledValue } from "../../../state/hooks/live-ticker-financials";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { normalizeSymbol } from "../../../utils/exchanges";
import {
  liveViewColumns,
  liveViewDecimalFloors,
  overlayViewRow,
  viewRowQuote,
  viewRowSymbol,
  viewStreamTargets,
  type ViewRowRange,
} from "./live-quotes";
import { loadViewSource } from "./loader";
import { sizeViewColumns, viewCellColumns, viewCellExportValue, viewCellText, type ViewTableColumn } from "./table";
import {
  applyViewProjection,
  EXAMPLE_VIEW_SPEC,
  growViewColumnDecimals,
  parseViewSpecOr,
  type ViewRow,
  type ViewSort,
  type ViewSpec,
} from "./view-spec";

export const CUSTOM_VIEW_PANE_ID = "custom-view";
export const CUSTOM_VIEW_SPEC_SETTING = "spec";

const NO_ROWS: ViewRow[] = [];
const NO_SYMBOLS: readonly (string | null)[] = [];
const NO_TARGETS: QuoteSubscriptionTarget[] = [];
const NO_DECIMALS: ReadonlyMap<string, number> = new Map();
/** Live values move every tick; filters and sort follow them at most this often. */
const LIVE_VIEW_ORDER_SAMPLE_MS = 5_000;
/** Header and border rows above the table body. */
const TABLE_CHROME_ROWS = 2;

function viewInstrument(symbol: string): InstrumentRef {
  return { symbol: normalizeSymbol(symbol), exchange: "", instrument: null };
}

function sameSymbols(left: readonly (string | null)[], right: readonly (string | null)[]): boolean {
  return left.length === right.length && left.every((symbol, index) => symbol === right[index]);
}

/** The first number a column holds, which an `index100` column is rebased to. */
function indexBases(columns: readonly { key: string; transform?: string }[], rows: readonly ViewRow[]): Map<string, number> {
  const bases = new Map<string, number>();
  for (const column of columns) {
    if (column.transform !== "index100") continue;
    const first = rows.find((row) => typeof row[column.key] === "number")?.[column.key];
    if (typeof first === "number") bases.set(column.key, first);
  }
  return bases;
}

/** What an empty view says: ask for one, or open one from a spec that works as typed. */
const EMPTY_VIEW_MESSAGE = `Ask Gloom: "make a view of the top S&P movers", or open one from a spec: VIEW ${EXAMPLE_VIEW_SPEC}`;

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
  const [visibleRange, setVisibleRange] = useState<ViewRowRange | null>(null);
  // Symbols in the order the table last showed them. The stream window is cut
  // from it; it trails the rows by one commit because the rows' order depends
  // on the live values the window brings in.
  const [streamOrder, setStreamOrder] = useState<readonly (string | null)[]>(NO_SYMBOLS);

  const loader = useCallback(async () => {
    if (!spec) throw new Error(specError ?? "This view has no spec yet.");
    const controller = new AbortController();
    return loadViewSource(spec, config, controller.signal);
  }, [config, spec, specError]);
  const { data, loading, error, reload, reloadAndWait, updatedAt } = useAsyncResource(spec ? loader : null);
  useAutoRefresh(updatedAt, reload);

  useEffect(() => {
    setSort(undefined);
  }, [spec]);

  const columns = useMemo(() => (spec ? viewCellColumns(spec, data?.columns ?? []) : []), [data?.columns, spec]);
  const symbolKey = spec?.presentation.symbolKey ?? (columns.some((column) => column.key === "symbol") ? "symbol" : null);

  // Price, change and volume columns of rows that name a symbol stream through
  // the shared quote feed; every other column keeps the loader's refresh.
  const liveFields = useMemo(() => liveViewColumns(data?.columns ?? []), [data?.columns]);
  const streamable = liveFields.size > 0 && !!symbolKey;
  const sourceRows = data?.rows ?? NO_ROWS;
  const rowInstruments = useMemo(() => sourceRows.map((row) => {
    const symbol = streamable ? viewRowSymbol(row, symbolKey) : null;
    if (!symbol) return null;
    const instrument = viewInstrument(symbol);
    return { instrument, key: buildQuoteKey(instrument) };
  }), [sourceRows, streamable, symbolKey]);
  // The table reports its window once it lays out; until then, assume the top
  // of the list fills the pane.
  const streamRange = visibleRange ?? { start: 0, end: Math.max(1, height - TABLE_CHROME_ROWS) };
  const quoteTargets = useMemo<QuoteSubscriptionTarget[]>(
    () => (streamable ? viewStreamTargets(streamOrder, streamRange, selectedIndex) : NO_TARGETS),
    [selectedIndex, streamOrder, streamRange.end, streamRange.start, streamable],
  );
  const { entries: liveQuotes } = useLiveQuoteEntries(quoteTargets);
  const liveRows = useMemo(() => {
    if (!streamable) return sourceRows;
    // Rows outside the window read the store without subscribing, so a row
    // scrolled away keeps the last value it streamed instead of snapping back.
    const coordinator = getSharedMarketDataCoordinator();
    return sourceRows.map((row, index) => {
      const ref = rowInstruments[index];
      if (!ref) return row;
      const entry = liveQuotes.get(ref.key) ?? coordinator?.getQuoteEntry(ref.instrument);
      return overlayViewRow(row, viewRowQuote(entry, updatedAt), liveFields);
    });
  }, [liveFields, liveQuotes, rowInstruments, sourceRows, streamable, updatedAt]);
  // Filtering and sorting on live values at tick speed would shuffle rows
  // under the cursor, so the order follows sampled values instead.
  const orderInput = useSampledValue(
    liveRows,
    LIVE_VIEW_ORDER_SAMPLE_MS,
    `${updatedAt ?? ""}:${sort ? `${sort.by}:${sort.direction}` : String(sort)}`,
  );
  const orderedRows = useMemo(
    () => (spec && data ? applyViewProjection(orderInput, spec.projection, sort) : NO_ROWS),
    [data, orderInput, sort, spec],
  );
  const rows = useMemo(() => {
    if (orderInput === liveRows) return orderedRows;
    const indexOf = new Map(orderInput.map((row, index) => [row, index]));
    return orderedRows.map((row) => liveRows[indexOf.get(row) ?? -1] ?? row);
  }, [liveRows, orderInput, orderedRows]);
  const displayedSymbols = useMemo(
    () => (streamable ? orderedRows.map((row) => viewRowSymbol(row, symbolKey)) : NO_SYMBOLS),
    [orderedRows, streamable, symbolKey],
  );
  useEffect(() => {
    setStreamOrder((current) => (sameSymbols(current, displayedSymbols) ? current : displayedSymbols));
  }, [displayedSymbols]);
  const baseByColumn = useMemo(() => indexBases(columns, rows), [columns, rows]);
  const decimalFloors = useMemo(() => liveViewDecimalFloors(sourceRows, liveFields), [liveFields, sourceRows]);
  // A column's decimals only grow while this spec is shown, so a tick that
  // crosses 100 or lands on a whole number never reflows the column.
  const heldDecimals = useRef<{ spec: ViewSpec | null; decimals: ReadonlyMap<string, number> }>({ spec: null, decimals: NO_DECIMALS });
  const decimalsByColumn = useMemo(() => {
    const held = heldDecimals.current.spec === spec ? heldDecimals.current.decimals : NO_DECIMALS;
    const decimals = growViewColumnDecimals(held, rows, columns.flatMap((column) => (
      column.transform === "percent" || column.transform === "index100"
        ? []
        : [{ key: column.key, minimum: decimalFloors.get(column.key) }]
    )));
    heldDecimals.current = { spec, decimals };
    return decimals;
  }, [columns, decimalFloors, rows, spec]);
  // Sized on the rows as loaded, so a live tick never moves a column; again only when a column's decimals grow.
  const liveKeys = useMemo(() => new Set(liveFields.keys()), [liveFields]);
  const tableColumns = useMemo(() => {
    const bases = indexBases(columns, sourceRows);
    return sizeViewColumns(columns, sourceRows, (row, column) => (
      viewCellText(row, column, bases.get(column.key), decimalsByColumn.get(column.key))
    ), liveKeys);
  }, [columns, decimalsByColumn, liveKeys, sourceRows]);
  const activeSort = sort === undefined ? spec?.projection.sort ?? null : sort;
  // Memoized so the table's row memo holds while the selection moves.
  const rowKey = useCallback((row: ViewRow, index: number) => (
    `${symbolKey && typeof row[symbolKey] === "string" ? row[symbolKey] : ""}:${index}`
  ), [symbolKey]);
  const renderRowCell = useCallback((row: ViewRow, column: ViewTableColumn) => {
    const value = viewCellExportValue(row, column);
    return {
      text: viewCellText(row, column, baseByColumn.get(column.key), decimalsByColumn.get(column.key)),
      ...(value !== undefined ? { value } : {}),
      color: column.key === symbolKey ? colors.textBright : undefined,
    };
  }, [baseByColumn, decimalsByColumn, symbolKey]);

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
        const specText = await dialog.prompt<string>({
          size: "large",
          content: (context: PromptContext<string>) => (
            <TextPromptDialog
              {...context}
              title={`Publish a revision of ${current.name}`}
              body={[`Edit the spec, or ask Gloom to. Enter publishes r${current.revision + 1}.`]}
              initialValue={JSON.stringify("spec" in currentParsed ? currentParsed.spec : current.spec, null, 2)}
              multiline
              rows={10}
              confirmLabel="Publish"
              footer="Shift+Enter newline · Esc cancel"
            />
          ),
        }).catch(logFailure("custom-view.pane", "The view revision prompt failed"));
        const edited = specText ? parseViewSpecOr(specText) : null;
        if (!edited) return;
        if ("error" in edited) throw new Error(edited.error);
        try {
          const published = await apiClient.publishTeamViewRevision(current.id, {
            spec: edited.spec as unknown as Record<string, unknown>,
            expectedRevision: current.revision,
          });
          teamViewsStore.upsert(published);
          notify({ body: `Published ${published.name} r${published.revision}.`, type: "success" });
          reload();
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
          }).catch(logFailure("custom-view.pane", "The view conflict prompt failed"));
          if (choice === "overwrite") {
            const published = await apiClient.publishTeamViewRevision(current.id, {
              spec: edited.spec as unknown as Record<string, unknown>,
              expectedRevision: error.currentRevision,
            });
            teamViewsStore.upsert(published);
            notify({ body: `Published ${published.name} r${published.revision}.`, type: "success" });
          }
          reload();
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
        }).catch(logFailure("custom-view.pane", "The view team prompt failed"));
      if (!teamId) return;
      const name = await dialog.prompt<string>({
        content: (context: PromptContext<string>) => (
          <TextPromptDialog
            {...context}
            title="View name"
            initialValue={instance.title ?? spec.presentation.title ?? ""}
            placeholder="Top movers"
            confirmLabel="Publish"
            width={40}
          />
        ),
      }).catch(logFailure("custom-view.pane", "The view name prompt failed"));
      if (!name) return;
      const created = await apiClient.createTeamView(teamId, {
        name,
        spec: { ...spec, presentation: { ...spec.presentation, title: name } } as unknown as Record<string, unknown>,
      });
      teamViewsStore.upsert(created);
      // This pane now follows the team view, so a teammate's revision reaches it.
      const registry = getSharedRegistry();
      if (registry) {
        const following: ViewSpec = {
          version: 1,
          source: { kind: "ref", viewId: created.id, teamId },
          projection: { columns: [], filters: [] },
          presentation: { title: name },
        };
        registry.updateLayout(setPaneSettings(registry.getLayout(), instance.instanceId, {
          ...instance.settings,
          ...customViewInstanceSettings(following),
        }));
      }
      const team = teams.find((entry) => entry.id === teamId);
      notify({ body: `Published "${name}" to ${team?.name ?? "the team"}. Members find it as ${team ? teamPrefix(team) : ""} ${name}.`, type: "success" });
    } catch (error) {
      notify({ body: error instanceof Error ? error.message : "Could not publish the view.", type: "error" });
    }
  }, [dialog, instance, notify, reload, spec]);

  useShortcut((event) => {
    if (!focused) return;
    if (event.name === "r" && !event.ctrl && !event.meta) {
      event.preventDefault?.();
      reload();
    } else if (isPlainKey(event, "t") && spec) {
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
    return specError
      ? <PaneStatusBody error={specError} errorTitle="This view's spec is invalid." />
      : <PaneStatusBody empty emptyTitle="This view is empty." emptyMessage={EMPTY_VIEW_MESSAGE} />;
  }

  if (loading && !data) {
    return <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading view..." />;
  }
  if (error && !data) {
    return (
      <PaneStatusBody
        error={error}
        errorTitle="This view could not load."
        retry={{ onRetry: reloadAndWait }}
      />
    );
  }
  if (rows.length === 0) {
    // The footer carries the source's failure, if any.
    return <PaneStatusBody empty emptyTitle="No rows match this view." />;
  }

  return (
    <DataTableView<ViewRow, ViewTableColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      selection={{
        kind: "index",
        selectedIndex,
        onChange: (index) => setSelectedIndex(index),
      }}
      columns={tableColumns}
      items={rows}
      sortColumnId={activeSort?.by ?? null}
      sortDirection={activeSort?.direction ?? "desc"}
      // A view can start unsorted; the pane menu still offers Sort by.
      sortable
      onHeaderClick={(id) => setSort((current) => {
        const active = current === undefined ? spec.projection.sort ?? null : current;
        return active?.by === id
          ? { by: id, direction: active.direction === "desc" ? "asc" : "desc" }
          : { by: id, direction: "desc" };
      })}
      getItemKey={rowKey}
      renderCell={renderRowCell}
      onVisibleRangeChange={setVisibleRange}
      onActivate={(row) => {
        const symbol = symbolKey ? row[symbolKey] : null;
        if (typeof symbol === "string" && symbol) selectTicker(symbol);
      }}
      emptyStateTitle="No rows."
    />
  );
}
