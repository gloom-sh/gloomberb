import {
  staticSeries,
  scalarPoint,
} from "../../../components/chart/static/series";
import { loadPortfolioOptionBook } from "./risk-options";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { Box, ScrollBox, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import {
  chartTableChromeRows,
  Button,
  ChartTableHeader,
  DataTableStackView,
  EmptyState,
  formatPercentAxis,
  PaneStatusBody,
  spanAxisFormatter,
  StatGrid,
  StaticChartSurface,
  QueryBar,
  statGridRows,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneTabs,
  type ChartTableChart,
  type DataTableColumn,
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
import { colors, priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { formatCompactAmount, formatPercentRaw } from "../../../utils/format";
import { isAccessDenied } from "../../../api-client/errors";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPortfolioRiskMarket } from "./risk-client";
import { brokerPerformanceEvidence, parsePortfolioRiskEvidence } from "./risk-evidence";
import { useBrokerPortfolioPerformance } from "./broker-performance";
import { accountDailyReturns } from "./account-returns";
import { usePortfolioBook } from "./portfolio-book";
import {
  buildPortfolioRisk,
  DEFAULT_RISK_SHIFTS,
  HOLDINGS_SUMMARY_ROW_IDS,
  portfolioRiskTickers,
  riskPercentile,
  riskValue,
  type PortfolioRiskModel,
  type RiskDisplayRow,
} from "./risk-model";
import {
  describePortfolioTab,
  resolvePortfolioId,
  resolveTemplatePortfolioId,
} from "./portfolio-selection";

/**
 * The model's views plus Sectors, which the pane values from live quotes and
 * FX so non-USD holdings count; reports and screenshots carry the model's only.
 */
const PANE_VIEWS = [
  "risk",
  "factors",
  "holdings",
  "sectors",
  "correlation",
  "stress",
  "performance",
  "attribution",
  "greeks",
] as const;
type PaneView = (typeof PANE_VIEWS)[number];
/** A sector row carries the holdings' value and P&L beside its weight. */
type PaneRow = RiskDisplayRow & { marketValue?: number | null; pnl?: number | null; pnlPct?: number | null };
const titles: Record<PaneView, string> = {
  risk: "Risk",
  factors: "Factors",
  holdings: "Holdings",
  sectors: "Sectors",
  correlation: "Correlation",
  stress: "Stress",
  performance: "Performance",
  attribution: "Attribution",
  greeks: "Greeks",
};
const tabs = PANE_VIEWS.map((value) => ({ value, label: titles[value] }));
const getKey = (row: RiskDisplayRow) => row.id;
/** The two return rows chart the basket against SPY over the window they measure. */
const RETURN_ROW_IDS: ReadonlySet<string> = new Set(["return", "benchmark"]);
const formatPercentValue = (value: number) => `${value.toFixed(2)}%`;
const formatPlainAxis = spanAxisFormatter((value, digits) => value.toFixed(digits));
/** What the first column lists in each view. */
const LABEL_HEADERS: Record<PaneView, string> = {
  risk: "Metric",
  factors: "Factor",
  holdings: "Symbol",
  sectors: "Sector",
  correlation: "Pair",
  stress: "Scenario",
  performance: "Metric",
  attribution: "Sector",
  greeks: "Metric",
};
const EVIDENCE_VIEWS: ReadonlySet<PaneView> = new Set(["performance", "attribution", "greeks"]);
const ATTRIBUTION_PARTS = [
  { id: "allocation", label: "Allocation" },
  { id: "selection", label: "Selection" },
  { id: "interaction", label: "Interaction" },
] as const;
const SECTOR_PARTS = [
  { id: "marketValue", label: "Value", width: 10 },
  { id: "pnl", label: "P&L", width: 10 },
  { id: "pnlPct", label: "P&L %", width: 9 },
] as const;
function sectorCell(row: PaneRow, column: (typeof SECTOR_PARTS)[number]["id"]) {
  const value = row[column];
  if (value == null) return { text: "--", color: colors.textMuted };
  if (column === "marketValue") return { text: formatCompactAmount(value) };
  return {
    text: column === "pnl" ? formatCompactAmount(value, { signed: true }) : formatPercentRaw(value),
    color: priceColor(value),
  };
}
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
/**
 * Cumulative return of the current-weight basket and of SPY across the last
 * window of paired sessions: the path behind the two return rows, whose
 * values the legend ends on. The series take the rows' names.
 */
function basketReturnSeries(model: PortfolioRiskModel): ChartTableChart["series"] {
  const sample = model.sample.slice(-60);
  if (!sample.length) return [];
  const label = (id: string, fallback: string) => model.rows.risk.find((row) => row.id === id)?.label ?? fallback;
  let wealth = 1,
    benchmark = 1;
  const start = scalarPoint(new Date(sample[0]!.startDateKey), 0);
  return [
    staticSeries(
      [start, ...sample.map((row) => scalarPoint(new Date(row.dateKey), ((wealth *= 1 + row.value) - 1) * 100))],
      { id: "basket", label: label("return", "Basket return"), color: colors.positive },
    ),
    staticSeries(
      [start, ...sample.map((row) => scalarPoint(new Date(row.dateKey), ((benchmark *= 1 + row.benchmark) - 1) * 100))],
      { id: "benchmark", label: label("benchmark", "SPY return"), color: colors.textMuted },
    ),
  ];
}
/** A row's own dated history, from its first computed value; null when fewer than two points plot. */
function rowHistorySeries(row: RiskDisplayRow): ChartTableChart["series"] | null {
  const history = row.history ?? [];
  const first = history.findIndex((point) => point.value != null && Number.isFinite(point.value));
  if (first < 0 || history.slice(first).filter((point) => point.value != null).length < 2) return null;
  return [staticSeries(
    history.slice(first).map((point) => scalarPoint(new Date(point.date), point.value)),
    { id: row.id, label: row.label, color: colors.positive },
  )];
}
// No column: rows keep the model order (return, risk, tail), which reads better than A-Z.
const DEFAULT_SORT = { column: "", direction: "asc" as const };
const EMPTY_MODEL: PortfolioRiskModel | null = null;
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
  const view: PaneView = PANE_VIEWS.includes(savedView as PaneView)
    ? (savedView as PaneView)
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
  // Without flows the history still gives the account's daily returns, when it is daily.
  const accountReturns = useMemo(
    () => accountDailyReturns(brokerPerformance.performance),
    [brokerPerformance.performance],
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
    clearOnError: isAccessDenied,
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  const derived = useMemo(() => {
    if (frozen) return { model: frozen, error: null };
    if (!portfolio || (!resource.data && !evidenceText.trim() && !brokerEvidence && !accountReturns))
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
          accountReturns,
        ),
        error: null,
      };
    } catch (error) {
      return {
        model: buildPortfolioRisk(portfolio, localTickers, market, null, DEFAULT_RISK_SHIFTS, accountReturns),
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
    accountReturns,
    equity,
    rates,
    volatility,
  ]);
  const model = derived.model;
  const book = usePortfolioBook(portfolio ?? null, localTickers, {
    enabled: !frozen && (view === "sectors" || view === "performance"),
    // The broker's own return figure only when no row already states the period's return.
    brokerReturn: model?.rows.performance.some((row) => row.id === "twr") ? null : brokerPerformance.performance,
  });
  const summaryItems = useMemo(
    () => view === "holdings"
      ? holdingsSummaryItems((model?.rows.holdings ?? []).filter((row) => HOLDINGS_SUMMARY_ROW_IDS.has(row.id)))
      : view === "performance" ? book.band : [],
    [book.band, model, view],
  );
  const sectorRows = useMemo<PaneRow[]>(
    () => book.sectors.rows.map((row) => ({
      id: row.id,
      label: row.sector,
      value: row.weight == null ? null : row.weight * 100,
      unit: "% gross",
      percentile: null,
      asOf: null,
      detail: "",
      marketValue: row.value,
      pnl: row.pnl,
      pnlPct: row.returnPct,
    })),
    [book.sectors],
  );
  const rows = useMemo<PaneRow[]>(
    () =>
      (view === "sectors" ? sectorRows : (model?.rows[view] ?? []) as PaneRow[])
        .filter((row) => view !== "holdings" || !HOLDINGS_SUMMARY_ROW_IDS.has(row.id))
        .sort((a, b) => {
        if (!sort.column) return 0;
        const left = a[sort.column as keyof PaneRow],
          right = b[sort.column as keyof PaneRow];
        if (left == null) return right == null ? 0 : 1;
        if (right == null) return -1;
        return (
          (typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right))) *
          (sort.direction === "asc" ? 1 : -1)
        );
      }),
    [model, sectorRows, view, sort],
  );
  const openRow = rows.find((row) => row.id === open);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
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
  const unvaluedSectorSymbols = book.sectors.unvaluedSymbols;
  const notices = [
    ...(model?.warnings ?? []),
    ...(derived.error ? [derived.error] : []),
    ...(resource.error ? [resource.error] : []),
    ...(view === "sectors" && unvaluedSectorSymbols.length
      ? [`Weights unavailable: missing prices or FX for ${unvaluedSectorSymbols.join(", ")}.`]
      : []),
    ...(view === "performance" ? book.accountNotices : []),
    ...(view === "performance" && brokerPerformance.error ? [`Account history: ${brokerPerformance.error}`] : []),
  ];
  usePaneNoticeFooter({
    registrationId: "portfolio-risk-notices",
    notices,
    focused,
    enabled: !openRow,
  });
  const accountLoading = view === "performance" && brokerPerformance.loading;
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
        ...(accountLoading
          ? [{ id: "account-loading", parts: [{ text: "loading account history", tone: "muted" as const }] }]
          : []),
        // Sector values are live and converted to the base currency.
        ...(view === "sectors"
          ? [{ id: "asof", parts: [{ text: book.baseCurrency, tone: "muted" as const }] }]
          : model
          ? [
              {
                id: "asof",
                parts: [
                  {
                    text: `${sharedEvidence ? `${sharedEvidence} · ` : ""}${model.portfolio.currency} · ${model.rows[view].find((row) => row.asOf)?.asOf?.slice(0, 10) ?? "history unavailable"}${EVIDENCE_VIEWS.has(view) && model.evidence ? ` · ${model.evidence.source}` : ""}${frozen ? " · snapshot" : ""}`,
                    tone: "muted" as const,
                  },
                ],
              },
            ]
          : []),
        ...(view === "performance" && book.accountSource
          ? [{ id: "account", parts: [{ text: book.accountSource, tone: "muted" as const }] }]
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
    [resource.loading, accountLoading, model, view, frozen, actionStatus, hints, sharedEvidence, book.baseCurrency, book.accountSource],
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
  // The chart follows the selected row: its own history, or for the return
  // rows the basket against SPY. Performance charts the account's TWR.
  const chartRow = rows.find((row) => row.id === selected) ?? rows[0];
  const marketLoading = resource.loading && !resource.data;
  const chart = useMemo<ChartTableChart | null>(() => {
    if (!model) return null;
    if (view === "performance") {
      // Flow evidence first; without it, the broker's own daily returns.
      const points = model.performance?.points ?? model.account?.points;
      if (!points) return null;
      return {
        series: [staticSeries(
          points.map((row) => scalarPoint(new Date(row.date), (row.wealth - 1) * 100)),
          { id: "twr", label: "TWR", color: colors.positive, calendarSpaced: true },
        )],
        formatValue: formatPercentValue,
        formatAxisValue: formatPercentAxis,
        remoteKind: "portfolio-risk-history",
      };
    }
    if (!chartRow) return null;
    const series = view === "risk" && RETURN_ROW_IDS.has(chartRow.id) && model.sample.length
      ? basketReturnSeries(model)
      : rowHistorySeries(chartRow);
    // Holdings, pairs and scenarios carry no history; the metrics wait for theirs.
    if (!series?.length) return marketLoading && chartRow.history ? { loading: true } : null;
    const percent = chartRow.unit === "%";
    return {
      series,
      formatValue: percent
        ? formatPercentValue
        : (value: number) => sharedUnit ? value.toFixed(2) : riskValue({ ...chartRow, value }),
      formatAxisValue: percent ? formatPercentAxis : formatPlainAxis,
      remoteKind: "portfolio-risk-history",
    };
  }, [chartRow, marketLoading, model, sharedUnit, view]);
  const attributionParts = view === "attribution" && rows.some((row) => row.allocation != null);
  // Sectors are current and undated; their value, P&L and return take the date and evidence columns.
  const sectorParts = view === "sectors";
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
      ...(sectorParts
        ? SECTOR_PARTS.map((part) => ({ id: part.id, label: part.label, width: part.width, align: "right" as const }))
        : []),
      ...(showPercentile
        ? [{ id: "percentile", label: "Pctl 1Y", width: 8, align: "right" as const }]
        : []),
      ...(sharedDate || sectorParts
        ? []
        : [{ id: "asOf", label: "As of", width: 11, align: "left" as const }]),
      // Attribution's evidence is the three effects, now columns of their own.
      ...(width >= 95 && !sharedEvidence && !attributionParts && !sectorParts
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
    [width, view, valueHeader, sharedUnit, attributionParts, sectorParts, sharedEvidence, showPercentile, sharedDate],
  );
  const selectView = (value: string) => {
    setView(value);
    setOpen(null);
    setSelected(null);
  };
  // Sectors come from the holdings alone, so they show while the market history
  // loads or fails, and the strip stays so the user can reach them.
  const ready = !!model || view === "sectors";
  // The view strip takes a row when it is not in the title bar; the portfolio
  // bar, the holdings summary and the chart sit on the root view only.
  const { strip: tabStrip, rows: tabRows } = usePaneTabs(portfolio ? {
    tabs,
    activeValue: view,
    onSelect: selectView,
    focused: focused && !openRow,
    compact: true,
  } : null);
  const rootHeight = Math.max(3, height - tabRows);
  const evidenceMissing = EVIDENCE_VIEWS.has(view) && rows.length === 0;
  if (!portfolio)
    return (
      <EmptyState
        title="No local portfolio."
        hint="Add holdings in PF, then open PORT."
      />
    );
  if (!ready)
    return (
      <Box width={width} height={height} flexDirection="column">
        {tabStrip}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error}
          loadingLabel="Loading portfolio risk"
          emptyTitle="Risk data unavailable"
        />
      </Box>
    );
  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}
      <DataTableStackView<PaneRow, DataTableColumn>
        focused={focused}
        columns={columns}
        items={rows}
        getItemKey={getKey}
        rootBefore={
          <ChartTableHeader
            width={width}
            height={rootHeight}
            tableRows={rows.length}
            tableChromeRows={chartTableChromeRows(columns, width)}
            // In the root only: a detail changes nothing the portfolio filter picks.
            query={
              <QueryBar
                width={width}
                filters={[{
                  id: "portfolio",
                  label: "Portfolio",
                  value: portfolio.id,
                  options: (portfolios.length ? portfolios : [portfolio])
                    .map((row) => ({ value: row.id, label: describePortfolioTab(row, config.brokerInstances) })),
                  onChange: (id: string) => {
                    setPortfolio(id);
                    setOpen(null);
                  },
                }]}
              />
            }
            figures={summaryItems}
            chart={chart}
          />
        }
        rootHeight={rootHeight}
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
          if (column.id === "marketValue" || column.id === "pnl" || column.id === "pnlPct") return sectorCell(row, column.id);
          return { text: row.detail };
        }}
        // A sector has no history or evidence of its own to open.
        onActivate={(row) => { if (!sectorParts) setOpen(row.id); }}
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
        detailScrollRef={detailScrollRef}
        emptyContent={
          evidenceMissing ? (
            <PaneStatusBody
              empty
              emptyTitle="This view needs dated local evidence."
              emptyMessage={frozen ? undefined : "Copy version 1 evidence JSON, then import it from the clipboard."}
              actions={frozen ? undefined : <Button label="Import evidence" compact onPress={() => void importEvidence()} />}
            />
          ) : undefined
        }
        emptyStateTitle={sectorParts ? "No holdings in this portfolio." : "No comparable observations."}
      />
    </Box>
  );
}
