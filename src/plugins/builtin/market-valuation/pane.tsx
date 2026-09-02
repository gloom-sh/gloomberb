import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  EmptyState,
  SegmentedControl,
  Spinner,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { getCachedValuationBundle, loadValuationBundle } from "./client";
import { shortZoneLabel, type ValuationRangeId } from "./defs";
import { IndicatorDetail } from "./detail";
import { RANGE_OPTIONS, VALUATION_DEFAULTS } from "./settings";
import { selectValuationViews, type IndicatorViewModel, type ValuationBundle } from "./view";

type LoadState =
  | { status: "idle" }
  | { status: "loading"; previous: ValuationBundle | null }
  | { status: "ready"; bundle: ValuationBundle }
  | { status: "error"; message: string; previous: ValuationBundle | null };

type ColumnId = "name" | "value" | "zone" | "percentile" | "sigma";
interface Column extends DataTableColumn { id: ColumnId }

function bundleOf(state: LoadState): ValuationBundle | null {
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
    case "error":
      return state.previous;
    case "ready":
      return state.bundle;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function initialLoadState(): LoadState {
  const cached = getCachedValuationBundle();
  return cached ? { status: "ready", bundle: cached } : { status: "idle" };
}

function formatSigma(sigma: number): string {
  return `${sigma > 0 ? "+" : ""}${formatNumber(sigma, 1)}σ`;
}

function buildColumns(width: number): Column[] {
  const wide = width >= 64;
  const name = Math.max(10, width - (wide ? 38 : 28) - 2);
  return [
    { id: "name", label: "INDICATOR", width: name, align: "left" },
    { id: "value", label: "VALUE", width: 8, align: "right" },
    { id: "zone", label: "ZONE", width: 11, align: "right" },
    ...(wide ? [{ id: "percentile" as const, label: "RICH", width: 6, align: "right" as const }] : []),
    { id: "sigma", label: "TREND", width: 8, align: "right" },
  ];
}

function cellsFor(view: IndicatorViewModel): Record<ColumnId, DataTableCell> {
  return {
    name: { text: view.indicator.shortLabel, color: colors.textBright },
    value: { text: view.indicator.formatValue(view.current.ratio), color: view.zone.color },
    zone: { text: shortZoneLabel(view.zone.id), color: view.zone.color },
    // Both restated so a high number always means expensive, whichever way the
    // underlying measure runs, otherwise the columns cannot be read down.
    percentile: { text: formatNumber(view.richPercentile, 0), color: colors.text },
    sigma: { text: formatSigma(view.richSigma), color: colors.textMuted },
  };
}

export function MarketValuationPane({ focused, width, height }: PaneProps) {
  const [indicatorId, setIndicatorId] = usePaneSettingValue<string>(
    "indicator",
    VALUATION_DEFAULTS.indicator,
  );
  const [range, setRange] = usePaneSettingValue<ValuationRangeId>("range", VALUATION_DEFAULTS.range);
  const [state, setState] = useState<LoadState>(initialLoadState);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState((previous) => ({ status: "loading", previous: bundleOf(previous) }));
    try {
      const next = await loadValuationBundle();
      if (generation.current !== current) return;
      setState({ status: "ready", bundle: next });
      setLastUpdated(Date.now());
    } catch (error) {
      if (generation.current !== current) return;
      setState((previous) => ({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        previous: bundleOf(previous),
      }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(() => { void load(); }, [load]);
  const reload = refresh;
  useAutoRefresh(lastUpdated, refresh);

  useShortcut((event) => {
    if (!focused || event.name !== "r" || state.status === "loading") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    reload();
  });

  const bundle = bundleOf(state);
  const views = useMemo(
    () => (bundle ? selectValuationViews(bundle, range) : []),
    [bundle, range],
  );
  const selected = views.find((view) => view.indicator.id === indicatorId) ?? views[0] ?? null;

  const error = state.status === "error" ? state.message : bundle?.errors[0] ?? null;
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selected) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selected.asOf}`, tone: "muted" }] },
      { id: "delayed", parts: [{ text: "delayed", tone: "muted" }] },
    ];
    if (selected.observationStale) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    return info;
  }, [selected]);

  usePaneStatusFooter({
    registrationId: "market-valuation",
    loading: state.status === "loading",
    error,
    info: footerInfo,
  });

  if (!bundle && state.status !== "error") {
    return (
      <Box width={width} height={height} justifyContent="center" alignItems="center">
        <Spinner label="Loading market valuation..." />
      </Box>
    );
  }

  if (!selected) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState title="Market valuation unavailable." message={error ?? undefined} />
      </Box>
    );
  }

  const columns = buildColumns(width);
  const tableHeight = Math.min(views.length + 1, Math.max(2, height - 12));

  const rangeControl = (
    <Box flexDirection="row" height={1} paddingX={1} overflow="hidden" justifyContent="flex-end">
      <SegmentedControl
        options={RANGE_OPTIONS}
        value={range}
        onChange={(value) => setRange(value as ValuationRangeId)}
      />
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {rangeControl}
      {/* Desktop pane chrome makes the table frame flex-grow and ignore rootHeight,
          so pin the summary rows here and leave the rest to the detail. */}
      <Box flexDirection="column" width={width} height={tableHeight} flexShrink={0} overflow="hidden">
      <DataTableView<IndicatorViewModel, Column>
        focused={focused}
        rootWidth={width}
        rootHeight={tableHeight}
        columns={columns}
        items={views}
        sortColumnId={null}
        sortDirection="asc"
        selection={{
          kind: "id",
          selectedId: selected.indicator.id,
          getId: (view) => view.indicator.id,
          onChange: (id) => setIndicatorId(String(id)),
        }}
        onCursorChange={(view) => setIndicatorId(view.indicator.id)}
        onHeaderClick={() => {}}
        getItemKey={(view) => view.indicator.id}
        renderCell={(view, column) => cellsFor(view)[column.id]}
        emptyStateTitle={error ?? "No valuation indicators."}
      />
      </Box>
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column" paddingBottom={1}>
          <IndicatorDetail view={selected} width={width} height={Math.max(12, height - tableHeight - 2)} />
        </Box>
      </ScrollBox>
      {error ? (
        <Box height={1} paddingX={1} overflow="hidden">
          <Text fg={colors.warning}>{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
