import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useUiCapabilities, useUiHost } from "../../../ui";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
  useShortcut,
} from "../../../public/react";
import {
  DataTableView,
  EmptyState,
  Icon,
  PaneFooterScope,
  PaneStatusBody,
  Popover,
  QueryBar,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import type {
  RevenueBreakdownRow,
  RevenueBreakdownView,
} from "../../../api-client/revenue-breakdown";
import { blendHex, priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { isPlainKey } from "../../../utils/keyboard";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { usePlanAccess } from "../shared/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { listingIdentity } from "../shared/ticker-request";
import { QuarterBars, type BarHover } from "./bars";
import {
  cachedRevenueBreakdown,
  loadRevenueBreakdown,
  NO_BREAKDOWN,
  REVENUE_VIEWS,
} from "./client";
import {
  barLevels,
  growthPercent,
  nextRevenueSort,
  quarterLabel,
  REVENUE_MODES,
  reportedSpan,
  revenueAmount,
  revenueColumns,
  sharedMaximum,
  sharePercent,
  sortRevenueRows,
  VIEW_NOUNS,
  type RevenueMode,
  type RevenueSort,
} from "./model";

export const REVENUE_BREAKDOWN_PANE_ID = "revenue-breakdown";

/** Placeholder rows drawn under a preview, whatever the number withheld. */
const MAX_LOCKED_ROWS = 3;

type Item =
  | { kind: "row"; row: RevenueBreakdownRow }
  | { kind: "locked"; index: number; label: boolean };

/** Stable pseudo-random bar heights for the placeholder rows. */
function placeholderLevels(count: number, seed: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const x = Math.sin((index + 1) * 12.9898 + seed * 78.233) * 43758.5453;
    return 0.25 + 0.7 * (x - Math.floor(x));
  });
}

function Blurred({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" style={{ filter: "blur(5px)", userSelect: "none" }}>
      {children}
    </Box>
  );
}

function UpgradeLabel({ noun, onPress }: { noun: string; onPress: () => void }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" gap={1} onMouseDown={onPress} data-gloom-role="revenue-upgrade">
      <Icon name="lock" size={11} color={colors.textBright} />
      <Text fg={colors.textBright}>{`Upgrade to see every ${noun}`}</Text>
    </Box>
  );
}

/**
 * Desktop: the prompt floats centred over the blurred rows, like a paywall
 * over the real table. It sits in the table's after-body slot, which starts
 * where the rows end, so it reaches back up over the last `rows` rows.
 */
function LockedOverlay({ rows, noun, onPress }: { rows: number; noun: string; onPress: () => void }) {
  const { cellHeightPx = 18 } = useUiCapabilities();
  return (
    <Box
      style={{
        position: "absolute",
        top: -rows * cellHeightPx,
        left: 0,
        width: "100%",
        height: rows * cellHeightPx,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <Box style={{ pointerEvents: "auto", cursor: "pointer" }}>
        <UpgradeLabel noun={noun} onPress={onPress} />
      </Box>
    </Box>
  );
}

function RevenueBreakdownView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const { ticker, symbol: boundSymbol } = usePaneTickerIdentity();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const pro = access.hasProAccess;
  const openUpgrade = useCloudUpgradeAction();
  const identity = listingIdentity(boundSymbol, ticker?.metadata.exchange ?? "");
  const symbol = identity?.symbol ?? null;
  const [requestedView, setView] = usePaneSettingValue<RevenueBreakdownView>("view", "product");
  const [mode, setMode] = usePluginPaneState<RevenueMode>("revenue:mode", "trend");
  const [sort, setSort] = usePluginPaneState<RevenueSort>("revenue:sort", { column: "revenue", direction: "desc" });
  const view = REVENUE_VIEWS.includes(requestedView) ? requestedView : "product";

  const loader = useCallback(
    (force: boolean) => loadRevenueBreakdown(symbol!, view, pro, force),
    [symbol, view, pro, session.requestKey],
  );
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => (symbol ? cachedRevenueBreakdown(symbol, view, pro) : null),
    clearOnError: (error) => error instanceof Error && error.message === NO_BREAKDOWN,
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && isPlainKey(event, "r")) {
      event.preventDefault();
      void resource.reload();
    }
  });

  const payload = useMemo(
    () => (resource.data ? reportedSpan(resource.data.payload) : null),
    [resource.data],
  );
  const preview = payload?.access === "preview" && payload.lockedRows > 0;
  const noun = VIEW_NOUNS[payload?.view ?? view];

  usePaneStatusFooter({
    registrationId: "revenue-breakdown",
    loading: resource.loading,
    error: payload ? resource.error : null,
    info: payload
      ? [
        ...(payload.filed ? [{ id: "filed", parts: [{ text: `filed ${payload.filed}`, tone: "muted" as const }] }] : []),
        ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ]
      : [],
    hints: preview
      ? [{ id: "revenue-upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }]
      : undefined,
  });

  const rows = useMemo(() => (payload ? sortRevenueRows(payload.rows, sort) : []), [payload, sort]);
  const sharedMax = useMemo(() => (payload ? sharedMaximum(payload.rows) : 0), [payload]);
  const items = useMemo<Item[]>(() => {
    const real = rows.map((row) => ({ kind: "row" as const, row }));
    if (!preview || !payload) return real;
    const count = Math.min(MAX_LOCKED_ROWS, payload.lockedRows);
    const labelAt = Math.floor((count - 1) / 2);
    return [...real, ...Array.from({ length: count }, (_, index) => ({ kind: "locked" as const, index, label: index === labelAt }))];
  }, [payload, preview, rows]);
  const columns = useMemo<DataTableColumn[]>(() => {
    if (!payload) return [];
    const base = revenueColumns(payload, mode);
    // In the terminal the upgrade line sits in the label column, so it must fit there.
    return preview && !isDesktopWeb
      ? base.map((column) => column.id === "label"
        ? { ...column, width: Math.max(column.width, `Upgrade to see every ${noun.plural}`.length + 4) }
        : column)
      : base;
  }, [isDesktopWeb, mode, noun.plural, payload, preview]);

  // The quarter under the pointer. Moving between bars sends an out before
  // the next over, so clearing waits a beat and a new hover cancels it.
  const [hover, setHover] = useState<(BarHover & { rowKey: string }) | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);
  const hoverRow = useCallback((rowKey: string, next: BarHover | null) => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = null;
    if (next) setHover({ ...next, rowKey });
    else clearTimer.current = setTimeout(() => setHover(null), 80);
  }, []);
  const hoverText = useMemo(() => {
    if (!hover || !payload) return null;
    const row = payload.rows.find((item) => item.key === hover.rowKey);
    const period = payload.periods[hover.index];
    if (!row || !period) return null;
    const value = row.values[hover.index] ?? null;
    return `${quarterLabel(period)}  ${value === null ? "not reported" : revenueAmount(value)}`;
  }, [hover, payload]);

  const placeholder = blendHex(colors.bg, colors.textMuted, 0.35);
  const renderCell = useCallback((item: Item, column: DataTableColumn): DataTableCell => {
    if (item.kind === "locked") {
      if (column.id === "label" && item.label && !isDesktopWeb) {
        const text = `Upgrade to see every ${noun.plural}`;
        return { text, content: <UpgradeLabel noun={noun.plural} onPress={openUpgrade} />, onMouseDown: openUpgrade };
      }
      const periods = payload?.periods.length ?? 0;
      if (column.id === "trend") {
        const bars = <QuarterBars levels={placeholderLevels(periods, item.index)} width={column.width} muted />;
        return { text: "", content: isDesktopWeb ? <Blurred>{bars}</Blurred> : bars };
      }
      const size = column.id === "label" ? 8 + ((item.index * 5) % 9) : 5;
      if (isDesktopWeb) {
        const sample = column.id === "label" ? "Hidden line of business".slice(0, size + 4) : "12.3B";
        return { text: "", content: <Blurred><Text fg={colors.textDim}>{sample}</Text></Blurred> };
      }
      return { text: "░".repeat(Math.min(size, column.width - 1)), color: placeholder };
    }
    const row = item.row;
    if (column.id === "label") return { text: row.label, color: colors.text };
    if (column.id === "trend") {
      return {
        text: "",
        content: (
          <QuarterBars
            levels={barLevels(row.values, mode, sharedMax)}
            width={column.width}
            activeIndex={hover?.rowKey === row.key ? hover.index : null}
            onHover={(next) => hoverRow(row.key, next)}
          />
        ),
      };
    }
    if (column.id === "revenue") return { text: revenueAmount(row.values.at(-1) ?? null), color: colors.textBright };
    if (column.id === "ttm") return { text: revenueAmount(row.ttm), color: colors.text };
    if (column.id === "share") return { text: sharePercent(row.share), color: colors.text };
    if (column.id === "yoy") return { text: growthPercent(row.yoy), color: row.yoy === null ? colors.textDim : priceColor(row.yoy) };
    return { text: revenueAmount(row.values[Number(column.id.slice(1))] ?? null), color: colors.textDim };
  }, [colors, hover, hoverRow, isDesktopWeb, mode, noun.plural, openUpgrade, payload?.periods.length, placeholder, sharedMax]);

  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (!payload && resource.error === NO_BREAKDOWN) {
    return <EmptyState title="No revenue breakdown." hint="This company's filings do not split revenue by product, segment or region." />;
  }

  return (
    <PaneStatusBody
      loading={resource.loading && !payload}
      error={!payload ? resource.error : null}
      subject="revenue breakdown"
    >
      {payload ? (
        <DataTableView<Item>
          columns={columns}
          items={items}
          focused={focused}
          rootWidth={width}
          rootHeight={height}
          selection={{ kind: "none" }}
          getItemKey={(item) => (item.kind === "row" ? item.row.key : `locked:${item.index}`)}
          sortColumnId={sort.column}
          sortDirection={sort.direction}
          onHeaderClick={(column) => setSort((old) => nextRevenueSort(old, column))}
          renderCell={renderCell}
          emptyStateTitle={`No ${noun.plural} rows.`}
          showHorizontalScrollbar={mode === "text"}
          bodyAfter={preview && isDesktopWeb ? (
            <LockedOverlay
              rows={items.length - rows.length}
              noun={noun.plural}
              onPress={openUpgrade}
            />
          ) : undefined}
          resetScrollKey={`${payload.symbol}:${payload.view}:${mode}`}
          rootBefore={(
            <QueryBar
              width={Math.max(1, width - 2)}
              filters={[{
                id: "view",
                label: "Split",
                inline: true,
                value: payload.view,
                options: REVENUE_VIEWS.map((option) => ({
                  value: option,
                  label: VIEW_NOUNS[option].label,
                  disabled: !payload.views.includes(option),
                })),
                onChange: (value: RevenueBreakdownView) => setView(value),
              }]}
              view={{
                value: mode,
                options: REVENUE_MODES,
                onChange: (value: RevenueMode) => setMode(value),
              }}
              // The terminal has no pointer tooltip, so the hovered quarter reads out here.
              meta={!isDesktopWeb && hover && hoverText
                ? `${payload.rows.find((item) => item.key === hover.rowKey)?.label ?? ""}  ${hoverText}`
                : payload.currency}
            />
          )}
        />
      ) : null}
      {isDesktopWeb && hover && hoverText && hover.x !== undefined && hover.y !== undefined ? (
        <Popover
          open
          onOpenChange={(open) => { if (!open) setHover(null); }}
          trigger={null}
          anchorPoint={{ x: hover.x, y: hover.y + 14 }}
          focusOnOpen={false}
          density="menu"
          label="Quarter value"
        >
          <Text fg={colors.textBright}>{hoverText}</Text>
        </Popover>
      ) : null}
    </PaneStatusBody>
  );
}

export function RevenueResearchTab({ width, height, focused }: TickerResearchTabProps) {
  return <RevenueBreakdownView width={width} height={height} focused={focused} />;
}

export function RevenueBreakdownPane({ width, height, focused }: PaneProps) {
  return (
    <PaneFooterScope active>
      <RevenueBreakdownView width={width} height={height} focused={focused} />
    </PaneFooterScope>
  );
}
