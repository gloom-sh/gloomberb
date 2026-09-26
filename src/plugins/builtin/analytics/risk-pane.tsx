import {
  staticSeries,
  scalarPoint,
} from "../../../components/chart/static/series";
import { loadPortfolioOptionBook } from "./risk-options";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { Box, ScrollBox, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import {
  Button,
  CompositeChart,
  DataTableStackView,
  EmptyState,
  PaneStatusBody,
  StatGrid,
  StaticChartSurface,
  QueryBar,
  Tabs,
  statGridRows,
  usePaneHeaderTabs,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableColumn,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginPaneState,
  useShortcut,
} from "../../../public/react";
import {
  getFocusedCollectionId,
  useAppSelector,
  usePaneInstance,
} from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { ApiRequestError } from "../../../api-client/errors";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPortfolioRiskMarket } from "./risk-client";
import { brokerPerformanceEvidence, parsePortfolioRiskEvidence } from "./risk-evidence";
import { useBrokerPortfolioPerformance } from "./broker-performance";
import {
  buildPortfolioRisk,
  HOLDINGS_SUMMARY_ROW_IDS,
  portfolioRiskTickers,
  riskPercentile,
  riskValue,
  RISK_VIEWS,
  type PortfolioRiskModel,
  type RiskDisplayRow,
  type RiskView,
} from "./risk-model";
import {
  resolvePortfolioId,
  resolveTemplatePortfolioId,
} from "./portfolio-selection";

const titles = {
  risk: "Risk",
  factors: "Factors",
  holdings: "Holdings",
  correlation: "Correlation",
  stress: "Stress",
  performance: "Performance",
  attribution: "Attribution",
  greeks: "Greeks",
};
const tabs = RISK_VIEWS.map((value) => ({ value, label: titles[value] }));
const getKey = (row: RiskDisplayRow) => row.id;
const PANELS = [{ id: "main" }];
/** What the first column lists in each view. */
const LABEL_HEADERS: Record<RiskView, string> = {
  risk: "Metric",
  factors: "Factor",
  holdings: "Symbol",
  correlation: "Pair",
  stress: "Scenario",
  performance: "Metric",
  attribution: "Sector",
  greeks: "Metric",
};
const EVIDENCE_VIEWS: ReadonlySet<RiskView> = new Set(["performance", "attribution", "greeks"]);
const ATTRIBUTION_PARTS = [
  { id: "allocation", label: "Allocation" },
  { id: "selection", label: "Selection" },
  { id: "interaction", label: "Interaction" },
] as const;
/** The unit every row shares, when it is a word worth moving into the header ("beta", "% gross"). */
function sharedWordUnit(rows: RiskDisplayRow[]): string | null {
  const unit = rows[0]?.unit;
  if (!unit || unit === "%" || !rows.every((row) => row.unit === unit)) return null;
  return unit;
}
const bareValue = (row: RiskDisplayRow) => row.value == null ? "--" : row.value.toFixed(2);
const HOLDINGS_SUMMARY_LABELS: Record<string, string> = { top: "Largest", "top-five": "Top five" };
/** The book concentration figures that lead the holdings view, as a summary band. */
function holdingsSummaryItems(rows: RiskDisplayRow[]): StatItem[] {
  return rows.map((row) => ({
    id: row.id,
    label: HOLDINGS_SUMMARY_LABELS[row.id] ?? row.label,
    value: row.value == null ? "--" : row.unit === "% gross" ? `${row.value.toFixed(2)}%` : row.value.toFixed(2),
    // "Absolute gross current exposure" is the same method note on both weights.
    detail: row.unit === "% gross" ? "gross" : row.detail,
  }));
}
// No column: rows keep the model order (return, risk, tail), which reads better than A-Z.
const DEFAULT_SORT = { column: "", direction: "asc" as const };
const EMPTY_MODEL: PortfolioRiskModel | null = null;
const clearDenied = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
function RiskDetail({
  row,
  width,
  height,
  scrollRef,
  focused = false,
}: {
  row: RiskDisplayRow;
  width: number;
  height: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  focused?: boolean;
}) {
  // Resolved per render so the chart follows the active theme.
  const themeColors = useThemeColors();
  const chartColors = useMemo(() => resolveChartPalette(themeColors, "positive"), [themeColors]);
  const items: StatItem[] = [
    {
      id: "value",
      label: "Value",
      value: riskValue(row),
      detail: row.asOf?.slice(0, 10) ?? "Source date unavailable",
    },
    ...(row.percentile != null ? [{ id: "percentile", label: "Pctl 1Y", value: riskPercentile(row) }] : []),
    { id: "evidence", label: "Evidence", value: row.detail, wide: true },
  ];
  const statRows = statGridRows(items, width);
  const points = (row.history ?? []).map((point, index) => ({
    date: new Date(point.date),
    time: Date.parse(point.date),
    sourceIndex: index,
    close: point.value ?? NaN,
    open: point.value ?? NaN,
    high: point.value ?? NaN,
    low: point.value ?? NaN,
    volume: 0,
  }));
  return (
    <ScrollBox ref={scrollRef} width={width} height={height} scrollY>
      <StatGrid items={items} width={width} />
      {points.filter((row) => Number.isFinite(row.close)).length > 1 && (
        <Box paddingX={1}>
          <StaticChartSurface
            points={points}
            width={Math.max(12, width - 2)}
            height={Math.max(5, height - statRows)}
            mode="line"
            calendarSpaced
            showTimeAxis
            colors={chartColors}
            yAxisLabel={row.unit}
            focused={focused}
          />
        </Box>
      )}
    </ScrollBox>
  );
}

export function PortfolioRiskPane({ focused, width, height }: PaneProps) {
  const instance = usePaneInstance(),
    renderer = useRendererHost();
  const portfolios = useAppSelector((state) => state.config.portfolios),
    tickers = useAppSelector((state) => state.tickers);
  const focusedCollection = useAppSelector((state) =>
    getFocusedCollectionId(state),
  );
  const [frozen] = usePaneSettingValue<PortfolioRiskModel | null>(
    "riskSnapshot",
    EMPTY_MODEL,
  );
  const fallback =
    resolvePortfolioId(portfolios, instance?.params?.portfolioId) ??
    resolveTemplatePortfolioId(portfolios, focusedCollection) ??
    "";
  const [selectedPortfolio, setPortfolio] = usePluginPaneState<string>(
    "risk:portfolio",
    fallback,
  );
  const portfolio =
    frozen?.portfolio ??
    portfolios.find((row) => row.id === selectedPortfolio) ??
    portfolios.find((row) => row.id === fallback);
  const [initialView] = usePaneSettingValue("riskView", "risk");
  const [savedView, setView] = usePluginPaneState<string>(
    "risk:view",
    initialView,
  );
  const view: RiskView = RISK_VIEWS.includes(savedView as RiskView)
    ? (savedView as RiskView)
    : "risk";
  const [evidenceText, setEvidenceText] = usePaneSettingValue(
    "riskEvidence",
    "",
  );
  // Imported evidence wins; otherwise the broker's own history supplies it when it can.
  const config = useAppSelector((state) => state.config);
  const brokerPerformance = useBrokerPortfolioPerformance(
    evidenceText.trim() ? null : portfolio ?? null,
    config,
  );
  const brokerEvidence = useMemo(
    () => portfolio && !evidenceText.trim()
      ? brokerPerformanceEvidence(portfolio, brokerPerformance.performance)
      : null,
    [brokerPerformance.performance, evidenceText, portfolio],
  );
  const [equity] = usePaneSettingValue("equityShift", -10),
    [rates] = usePaneSettingValue("rateShift", 100),
    [volatility] = usePaneSettingValue("volShift", 10);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [selected, setSelected] = usePluginPaneState<string | null>(
    "risk:selected",
    null,
  );
  const [open, setOpen] = usePluginPaneState<string | null>("risk:open", null);
  const [sort, setSort] = usePluginPaneState<{
    column: string;
    direction: "asc" | "desc";
  }>("risk:sort", DEFAULT_SORT);
  const localTickers = useMemo(
    () =>
      portfolio
        ? portfolioRiskTickers([...tickers.values()], portfolio.id)
        : [],
    [portfolio?.id, tickers],
  );
  const instruments = useMemo(
    () =>
      localTickers.slice(0, 80).map((row) => ({
        symbol: row.metadata.ticker,
        exchange: row.metadata.exchange,
      })),
    [localTickers],
  );
  const session = useResearchCloudSession();
  const loader = useCallback(
    async (force: boolean) => {
      const [market, brokerOptions] = await Promise.all([
        loadPortfolioRiskMarket(instruments, force),
        loadPortfolioOptionBook(localTickers, portfolio!),
      ]);
      return { ...market, brokerOptions };
    },
    [instruments, localTickers, portfolio, session.requestKey],
  );
  const resource = useAsyncResource(!frozen && portfolio ? loader : null, {
    clearOnError: clearDenied,
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  const derived = useMemo(() => {
    if (frozen) return { model: frozen, error: null };
    if (!portfolio || (!resource.data && !evidenceText.trim() && !brokerEvidence))
      return { model: null, error: null };
    const market = resource.data ?? {
      histories: [],
      yields: null,
      volatility: null,
      warnings: [],
      fetchedAt: new Date().toISOString(),
    };
    try {
      return {
        model: buildPortfolioRisk(
          portfolio,
          localTickers,
          market,
          evidenceText.trim() ? parsePortfolioRiskEvidence(evidenceText) : brokerEvidence,
          {
            equity: Number(equity),
            rates: Number(rates),
            volatility: Number(volatility),
          },
        ),
        error: null,
      };
    } catch (error) {
      return {
        model: buildPortfolioRisk(portfolio, localTickers, market),
        error: error instanceof Error ? error.message : "Evidence invalid",
      };
    }
  }, [
    frozen,
    portfolio,
    localTickers,
    resource.data,
    evidenceText,
    brokerEvidence,
    equity,
    rates,
    volatility,
  ]);
  const model = derived.model;
  const holdingsSummary = useMemo(
    () => view === "holdings" ? holdingsSummaryItems((model?.rows.holdings ?? []).filter((row) => HOLDINGS_SUMMARY_ROW_IDS.has(row.id))) : [],
    [model, view],
  );
  const rows = useMemo(
    () =>
      (model?.rows[view] ?? [])
        .filter((row) => view !== "holdings" || !HOLDINGS_SUMMARY_ROW_IDS.has(row.id))
        .sort((a, b) => {
        if (!sort.column) return 0;
        const left = a[sort.column as keyof RiskDisplayRow],
          right = b[sort.column as keyof RiskDisplayRow];
        if (left == null) return right == null ? 0 : 1;
        if (right == null) return -1;
        return (
          (typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right))) *
          (sort.direction === "asc" ? 1 : -1)
        );
      }),
    [model, view, sort],
  );
  const series = useMemo(() => {
    if (view === "risk" && model?.sample.length) {
      const sample = model.sample.slice(-60);
      let wealth = 1,
        benchmark = 1;
      const start = scalarPoint(new Date(sample[0]!.startDateKey), 0);
      return [
        staticSeries(
          [
            start,
            ...sample.map((row) =>
              scalarPoint(
                new Date(row.dateKey),
                ((wealth *= 1 + row.value) - 1) * 100,
              ),
            ),
          ],
          {
            id: "basket",
            label: "Current-weight basket",
            color: colors.positive,
          },
        ),
        staticSeries(
          [
            start,
            ...sample.map((row) =>
              scalarPoint(
                new Date(row.dateKey),
                ((benchmark *= 1 + row.benchmark) - 1) * 100,
              ),
            ),
          ],
          { id: "benchmark", label: "SPY", color: colors.textMuted },
        ),
      ];
    }
    if (view === "performance" && model?.performance)
      return [
        staticSeries(
          model.performance.points.map((row) =>
            scalarPoint(new Date(row.date), (row.wealth - 1) * 100),
          ),
          {
            id: "twr",
            label: "Account TWR",
            color: colors.positive,
            calendarSpaced: true,
          },
        ),
      ];
    return [];
  }, [model, view]);
  const openRow = rows.find((row) => row.id === open);
  // j/k scroll an open metric the way they move the table, as in other details.
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    const delta = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
    const scrollBox = detailScrollRef.current;
    if (!delta || !scrollBox?.viewport) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollBox.scrollTop + delta));
    return true;
  }, []);
  // Columns that say the same thing on every row belong in the footer, not repeated per row.
  const showPercentile = rows.some((row) => row.percentile != null);
  const sharedDate =
    rows.length > 1 &&
    rows.every((row) => row.asOf?.slice(0, 10) === rows[0]!.asOf?.slice(0, 10));
  const sharedEvidence =
    rows.length > 1 && rows.every((row) => row.detail === rows[0]!.detail)
      ? rows[0]!.detail
      : null;
  const importEvidence = useCallback(async () => {
    try {
      const text = await renderer.readText(),
        evidence = parsePortfolioRiskEvidence(text);
      if (
        !evidence ||
        evidence.portfolioId !== portfolio?.id ||
        evidence.currency !== portfolio?.currency
      )
        throw new Error(
          "Clipboard evidence must match the selected portfolio and currency",
        );
      setEvidenceText(JSON.stringify(evidence));
      setActionStatus("Evidence imported");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "Import failed");
    }
  }, [renderer, portfolio?.id, portfolio?.currency, setEvidenceText]);
  const nextPortfolio = useCallback(() => {
    const next =
      portfolios[
        (portfolios.findIndex((row) => row.id === portfolio?.id) + 1) %
          portfolios.length
      ];
    if (next) {
      setPortfolio(next.id);
      setOpen(null);
      setActionStatus(null);
    }
  }, [portfolios, portfolio?.id, setPortfolio, setOpen]);
  const hints = useMemo(
    () =>
      frozen
        ? []
        : [
            {
              id: "import",
              key: "i",
              label: "mport evidence",
              onPress: () => void importEvidence(),
            },
            ...(portfolios.length > 1
              ? [
                  {
                    id: "portfolio",
                    key: "p",
                    label: "ortfolio",
                    onPress: nextPortfolio,
                  },
                ]
              : []),
          ],
    [frozen, importEvidence, portfolios.length, nextPortfolio],
  );
  // Only real data limitations raise the footer warning; the empty evidence
  // views say what they need in the body, with the import action.
  const notices = [
    ...(model?.warnings ?? []),
    ...(derived.error ? [derived.error] : []),
    ...(resource.error ? [resource.error] : []),
  ];
  usePaneNoticeFooter({
    registrationId: "portfolio-risk-notices",
    notices,
    focused,
    enabled: !openRow,
  });
  usePaneFooter(
    "portfolio-risk",
    () => ({
      info: [
        ...(resource.loading
          ? [
              {
                id: "loading",
                parts: [
                  { text: "loading history", tone: "muted" as const },
                ],
              },
            ]
          : []),
        ...(model
          ? [
              {
                id: "asof",
                parts: [
                  {
                    text: `${sharedEvidence ? `${sharedEvidence} · ` : ""}${model.portfolio.currency} · ${model.rows[view].find((row) => row.asOf)?.asOf?.slice(0, 10) ?? "history unavailable"}${["performance", "attribution", "greeks"].includes(view) && model.evidence ? ` · ${model.evidence.source}` : ""}${frozen ? " · snapshot" : ""}`,
                    tone: "muted" as const,
                  },
                ],
              },
            ]
          : []),
        ...(actionStatus
          ? [
              {
                id: "import",
                parts: [{ text: actionStatus, tone: "muted" as const }],
              },
            ]
          : []),
      ],
      hints,
    }),
    [resource.loading, model, view, frozen, actionStatus, hints, sharedEvidence],
  );
  useShortcut(
    (event) => {
      if (
        event.defaultPrevented ||
        event.propagationStopped ||
        event.targetEditable ||
        event.ctrl ||
        event.alt ||
        event.meta
      )
        return;
      const hint = hints.find((row) => row.key === event.name);
      if (hint) {
        event.preventDefault();
        event.stopPropagation();
        hint.onPress();
      } else if (event.name === "r" && !frozen) void resource.reload();
    },
    { enabled: focused, scope: "portfolio-risk", phase: "before" },
  );
  // A unit every row shares goes in the value header, so the cells are bare numbers.
  const sharedUnit = sharedWordUnit(rows);
  const attributionParts = view === "attribution" && rows.some((row) => row.allocation != null);
  const valueHeader = attributionParts
    ? "Total pp"
    : sharedUnit
      ? sharedUnit.length <= 3 ? `Value ${sharedUnit}` : sharedUnit
      : "Value";
  const columns = useMemo<DataTableColumn[]>(
    () => [
      {
        id: "label",
        label: LABEL_HEADERS[view],
        width: Math.min(30, Math.max(19, width - 45)),
        align: "left",
      },
      {
        id: "value",
        label: valueHeader,
        width: sharedUnit || attributionParts ? Math.max(9, valueHeader.length) : 16,
        align: "right",
      },
      ...(attributionParts
        ? ATTRIBUTION_PARTS.map((part) => ({ id: part.id, label: part.label, width: 11, align: "right" as const }))
        : []),
      ...(showPercentile
        ? [{ id: "percentile", label: "Pctl 1Y", width: 8, align: "right" as const }]
        : []),
      ...(sharedDate
        ? []
        : [{ id: "asOf", label: "As of", width: 11, align: "left" as const }]),
      // Attribution's evidence is the three effects, now columns of their own.
      ...(width >= 95 && !sharedEvidence && !attributionParts
        ? [
            {
              id: "detail",
              label: "Evidence",
              width: 22,
              flexGrow: 1,
              align: "left" as const,
            },
          ]
        : []),
    ],
    [width, view, valueHeader, sharedUnit, attributionParts, sharedEvidence, showPercentile, sharedDate],
  );
  const selectView = (value: string) => {
    setView(value);
    setOpen(null);
    setSelected(null);
  };
  const tabsInHeader = usePaneHeaderTabs(portfolio && model ? {
    tabs,
    activeValue: view,
    onSelect: selectView,
    focused: focused && !openRow,
  } : null);
  // The view strip takes a row when it is not in the title bar; the portfolio
  // bar and the holdings summary sit on the root view only.
  const tabRows = tabsInHeader ? 0 : 1;
  const summaryRows = statGridRows(holdingsSummary, width);
  // The chart takes every row the table does not: bar, summary, header and rows.
  const tableRows = 1 + rows.length;
  const chartSpace = height - tabRows - 1 - summaryRows - tableRows;
  const chartHeight =
    series.length && height >= 18
      ? Math.max(Math.min(8, Math.floor(height * 0.4)), chartSpace)
      : 0;
  const evidenceMissing = EVIDENCE_VIEWS.has(view) && rows.length === 0;
  if (!portfolio)
    return (
      <EmptyState
        title="No local portfolio."
        hint="Add holdings in PF, then open PORT."
      />
    );
  if (!model)
    return (
      <PaneStatusBody
        loading={resource.loading}
        error={resource.error}
        loadingLabel="Loading portfolio risk"
        emptyTitle="Risk data unavailable"
      />
    );
  return (
    <Box width={width} height={height} flexDirection="column">
      {!tabsInHeader && (
        <Tabs
          tabs={tabs}
          activeValue={view}
          onSelect={selectView}
          focused={focused && !openRow}
          compact
        />
      )}
      <DataTableStackView<RiskDisplayRow, DataTableColumn>
        focused={focused}
        columns={columns}
        items={rows}
        getItemKey={getKey}
        rootBefore={
          <>
            {/* In the root only: a detail changes nothing the portfolio filter picks. */}
            <QueryBar
              width={width}
              filters={[{
                id: "portfolio",
                label: "Portfolio",
                value: portfolio.id,
                options: portfolios.length
                  ? portfolios.map((row) => ({ value: row.id, label: row.name }))
                  : [{ value: portfolio.id, label: portfolio.name }],
                onChange: (id: string) => {
                  setPortfolio(id);
                  setOpen(null);
                },
              }]}
            />
            <StatGrid items={holdingsSummary} width={width} />
            {chartHeight ? (
              <CompositeChart
                series={series}
                panels={PANELS}
                width={width}
                height={chartHeight}
                focused={focused && !openRow}
                showLegend
                showTimeAxis
                navigable={false}
                formatAxisValue={(value) => `${value.toFixed(1)}%`}
                formatValue={(value) => `${value.toFixed(2)}%`}
                remoteKind="portfolio-risk-history"
              />
            ) : null}
          </>
        }
        rootHeight={Math.max(3, height - tabRows)}
        resetScrollKey={`${portfolio.id}:${view}`}
        selection={{
          kind: "id",
          selectedId: selected,
          getId: getKey,
          onChange: setSelected,
        }}
        sortColumnId={sort.column}
        sortDirection={sort.direction}
        onHeaderClick={(column) =>
          setSort({
            column,
            direction:
              sort.column === column && sort.direction === "asc"
                ? "desc"
                : "asc",
          })
        }
        renderCell={(row, column) => {
          if (column.id === "label") return { text: row.label };
          if (column.id === "value") return { text: sharedUnit || attributionParts ? bareValue(row) : riskValue(row) };
          if (column.id === "percentile") return { text: riskPercentile(row) };
          if (column.id === "asOf") return { text: row.asOf?.slice(0, 10) ?? "--" };
          if (column.id === "allocation" || column.id === "selection" || column.id === "interaction") {
            const part = row[column.id];
            return { text: part == null ? "--" : part.toFixed(2) };
          }
          return { text: row.detail };
        }}
        onActivate={(row) => setOpen(row.id)}
        detailOpen={!!openRow}
        detailTitle={openRow?.label}
        onBack={() => setOpen(null)}
        detailContent={
          openRow ? (
            <RiskDetail
              row={openRow}
              width={width}
              height={Math.max(3, height - tabRows - 1)}
              scrollRef={detailScrollRef}
              focused={focused}
            />
          ) : null
        }
        onDetailKeyDown={handleDetailKeyDown}
        emptyContent={
          evidenceMissing ? (
            <Box paddingX={1} paddingY={1}>
              <EmptyState
                title="This view needs dated local evidence."
                message={frozen ? undefined : "Copy version 1 evidence JSON, then import it from the clipboard."}
                actions={frozen ? undefined : <Button label="Import evidence" compact onPress={() => void importEvidence()} />}
              />
            </Box>
          ) : undefined
        }
        emptyStateTitle="No comparable observations."
      />
    </Box>
  );
}
