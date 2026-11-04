import {
  staticSeries,
  scalarPoint,
} from "../../../components/chart/static/series";
import { loadPortfolioOptionBook } from "./risk-options";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  usePluginAppActions,
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
import { isAccessDenied } from "../../../api-client/errors";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPortfolioRiskMarket } from "./risk-client";
import { episodeProxyNotes, loadRiskEpisodeHistory, riskEpisodeTargets, type RiskEpisodeState, type RiskEpisodeTarget } from "./risk-episodes";
import { brokerPerformanceEvidence, parsePortfolioRiskEvidence } from "./risk-evidence";
import { useBrokerPortfolioPerformance } from "./broker-performance";
import { parseAssetShifts, parseFxShifts, riskCashLines } from "./risk-book";
import { resolvePortfolioAccountState } from "../portfolio-list/summary";
import {
  BASKET_VIEWS,
  buildPortfolioRisk,
  HOLDINGS_SHARE_UNIT,
  HOLDINGS_SUMMARY_ROW_IDS,
  isShockRow,
  NO_HOLDINGS_HINT,
  portfolioRiskRequests,
  portfolioRiskTickers,
  riskCoverageLine,
  riskCoverageNotices,
  riskCoverageShortfall,
  riskPercentile,
  riskEvidence,
  riskReturnsCurrency,
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
import { startBrokerAdd } from "../broker-manager/add-request";
import { CorrelationMatrixGrid, correlationMatrixFits, useCorrelationMatrixKeys } from "../correlation/matrix/grid";
import { clampMatrixCursor, type MatrixCursor } from "../correlation/matrix/selection";
import { usePluginTickerActions } from "../../runtime";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { formatTickerListInput } from "../../../tickers/list";

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
/** The two return rows chart the basket against its benchmark over the window they measure. */
const RETURN_ROW_IDS: ReadonlySet<string> = new Set(["return", "benchmark"]);
const formatPercentValue = (value: number) => `${value.toFixed(2)}%`;
const formatPlainAxis = spanAxisFormatter((value, digits) => value.toFixed(digits));
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
/**
 * What an empty Performance, Attribution or Greeks view is missing, in plain
 * words, and whether connecting a broker would bring it: a broker that reports
 * account history supplies Performance, and a broker's option positions
 * supply Greeks. No broker reports Attribution's sector book, so that view
 * offers the import alone.
 */
function evidenceNeed(
  view: RiskView,
  { brokerLinked, unvaluedOptions }: { brokerLinked: boolean; unvaluedOptions: boolean },
): { title: string; message?: string; broker: boolean } {
  if (view === "performance") {
    const title = "Performance needs this account's daily values and the money paid in and out.";
    return brokerLinked
      ? { title, message: "Its broker does not report them; import them as evidence JSON instead.", broker: false }
      : { title, message: "A connected broker that reports account history provides both.", broker: true };
  }
  if (view === "attribution")
    return {
      title: "Attribution needs sector weights and returns for this account and its benchmark.",
      message: "No broker reports them; import them as evidence JSON.",
      broker: false,
    };
  if (unvaluedOptions) return { title: "No option position in this portfolio could be valued.", broker: false };
  return brokerLinked
    ? { title: "No option positions in this portfolio.", broker: false }
    : { title: "No option positions in this portfolio.", message: "A connected broker syncs option positions with the rest of the account.", broker: true };
}
/** The risk view's tail rows, whose method the footer names. */
const TAIL_ROW_IDS: ReadonlySet<string> = new Set(["var", "es"]);
/** The views that read the basket's daily closes, and say to when; Holdings reads current marks. */
const DAILY_CLOSE_VIEWS: ReadonlySet<RiskView> = new Set(["risk", "factors", "correlation", "stress"]);
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
const CASH_ASIDE = ", cash aside";
/** The book concentration figures that lead the holdings view, as a summary band. */
function holdingsSummaryItems(rows: RiskDisplayRow[]): StatItem[] {
  // Every figure leaves the cash aside; the first one that says so says it for the band.
  let cashSaid = false;
  return rows.map((row) => {
    // A snapshot saved before the shares named their base reads "% value".
    const share = row.unit === HOLDINGS_SHARE_UNIT || row.unit === "% value";
    // The shares name what they divide.
    let detail = share ? (row.unit === HOLDINGS_SHARE_UNIT ? `of holdings${CASH_ASIDE}` : "of market value") : row.detail;
    if (detail.endsWith(CASH_ASIDE)) {
      if (cashSaid) detail = detail.slice(0, -CASH_ASIDE.length);
      cashSaid = true;
    }
    return {
      id: row.id,
      label: HOLDINGS_SUMMARY_LABELS[row.id] ?? row.label,
      value: row.value == null ? "--" : share ? `${row.value.toFixed(2)}%` : row.value.toFixed(2),
      detail,
    };
  });
}
/**
 * Cumulative return of the basket and of its benchmark across the window of
 * paired sessions the return rows measure (the last 60 at current weights, or
 * those since a 13F filing, bought and held unless current weights are
 * chosen): the path behind the two rows, whose values the legend ends on. The
 * series take the rows' names.
 */
function basketReturnSeries(model: PortfolioRiskModel): ChartTableChart["series"] {
  // A snapshot saved before the window existed covers the trailing 60.
  const sessions = model.window?.sessions ?? 60;
  const sample = sessions > 0 ? model.sample.slice(-sessions) : [];
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
      { id: "benchmark", label: label("benchmark", `${model.benchmark ?? "SPY"} return`), color: colors.textMuted },
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
/**
 * The basket's members, largest weight first, and each pair's correlation by
 * symbol, for the heat matrix. Null when two members share a symbol (two
 * listings of one name), which only the list of pairs tells apart.
 */
function basketCorrelationMatrix(model: PortfolioRiskModel): {
  symbols: string[];
  correlation: (row: string, column: string) => number | null;
} | null {
  const members = model.holdings.filter((row) => row.weight != null).sort((left, right) => right.weight! - left.weight!);
  const symbols = members.map((row) => row.symbol);
  if (new Set(symbols).size !== symbols.length) return null;
  const ids = new Map(members.map((row) => [row.symbol, row.id]));
  const pairs = new Map<string, number | null>();
  for (const row of model.correlation) {
    pairs.set(`${row.left}\u0000${row.right}`, row.value);
    pairs.set(`${row.right}\u0000${row.left}`, row.value);
  }
  return {
    symbols,
    correlation: (row, column) => row === column ? 1 : pairs.get(`${ids.get(row)}\u0000${ids.get(column)}`) ?? null,
  };
}
/**
 * An evidence view with nothing in it: what it needs, the broker route where a
 * broker brings it, then the import. A saved snapshot says only what it
 * lacked: nothing can be added to it.
 */
function EvidenceEmptyState({ need, onImport }: { need: ReturnType<typeof evidenceNeed>; onImport: (() => void) | null }) {
  return (
    <PaneStatusBody
      empty
      emptyTitle={need.title}
      emptyMessage={onImport ? need.message : undefined}
      actions={onImport ? <>
        {need.broker ? <Button label="Add Broker Account" compact onPress={startBrokerAdd} /> : null}
        <Button label="Import evidence" variant="secondary" compact onPress={onImport} />
      </> : undefined}
    />
  );
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
    { id: "evidence", label: "Evidence", value: riskEvidence(row), wide: true },
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
  const { showPane, createPaneFromTemplate } = usePluginAppActions();
  const portfolios = useAppSelector((state) => state.config.portfolios),
    tickers = useAppSelector((state) => state.tickers),
    brokerAccounts = useAppSelector((state) => state.brokerAccounts);
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
    [volatility] = usePaneSettingValue("volShift", 10),
    [fxShift] = usePaneSettingValue("fxShift", ""),
    [assetShift] = usePaneSettingValue("assetShift", ""),
    [since] = usePaneSettingValue("riskSince", "trailing"),
    [weights] = usePaneSettingValue("riskWeights", "13f");
  // Currency and price shocks as the settings give them; one that does not read is named in the footer, not applied.
  const shocks = useMemo(() => {
    const errors: string[] = [];
    function read<T>(text: unknown, parse: (text: string, flag: string) => T[], label: string): T[] {
      if (!String(text ?? "").trim()) return [];
      try {
        return parse(String(text), label);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `${label} unreadable`);
        return [];
      }
    }
    return { fx: read(fxShift, parseFxShifts, "FX shift"), assets: read(assetShift, parseAssetShifts, "Asset shift"), errors };
  }, [fxShift, assetShift]);
  // The cash beside the holdings: the broker account's last saved balances by currency, else the portfolio's own.
  const cash = useMemo(() => {
    if (!portfolio) return [];
    const account = resolvePortfolioAccountState(portfolio, { config, brokerAccounts }, { status: null, accounts: [] })?.account;
    return riskCashLines(portfolio, account);
  }, [brokerAccounts, config, portfolio]);
  // The currencies the load prices, kept by value so a resynced account with the same ones reloads nothing.
  const cashKey = cash.map((line) => line.currency).join(",");
  const cashCurrencies = useMemo(() => (cashKey ? cashKey.split(",") : []), [cashKey]);
  const riskWindow = useMemo(
    () => (since === "filed" ? { since: "filed" as const, weights: weights === "current" ? "current" as const : "13f" as const } : {}),
    [since, weights],
  );
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
  const requests = useMemo(
    () => (portfolio ? portfolioRiskRequests(localTickers, portfolio.id) : []),
    [localTickers, portfolio?.id],
  );
  const session = useResearchCloudSession();
  const loader = useCallback(
    async (force: boolean) => {
      const [market, brokerOptions] = await Promise.all([
        loadPortfolioRiskMarket(requests, force, portfolio!.currency, cashCurrencies),
        loadPortfolioOptionBook(localTickers, portfolio!),
      ]);
      return { ...market, brokerOptions };
    },
    [requests, localTickers, portfolio, cashCurrencies, session.requestKey],
  );
  const resource = useAsyncResource(!frozen && portfolio ? loader : null, {
    clearOnError: isAccessDenied,
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  // The Stress view's episodes read years-old closes of each holding, so they
  // load only there, once the market load says which holdings the basket takes.
  const episodeTargetsKey = useMemo(() => {
    if (frozen || view !== "stress" || !resource.data) return null;
    const held = localTickers.map((ticker) => ({ symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange }));
    const targets = riskEpisodeTargets(resource.data, held);
    return targets.length ? JSON.stringify(targets) : null;
  }, [frozen, localTickers, resource.data, view]);
  const episodeLoader = useMemo(
    () => (episodeTargetsKey && portfolio
      ? () => loadRiskEpisodeHistory(JSON.parse(episodeTargetsKey) as RiskEpisodeTarget[], portfolio.currency)
      : null),
    [episodeTargetsKey, portfolio?.currency, session.requestKey],
  );
  const episodeResource = useAsyncResource(episodeLoader, { clearOnError: isAccessDenied, keepPreviousData: true });
  const episodeState = useMemo<RiskEpisodeState | undefined>(
    () => (!episodeLoader
      ? undefined
      : episodeResource.data ?? { pending: episodeResource.error ? `daily closes did not load: ${episodeResource.error}` : "loading daily closes" }),
    [episodeLoader, episodeResource.data, episodeResource.error],
  );
  const derived = useMemo(() => {
    if (frozen) return { model: frozen, error: null };
    if (!portfolio || (!resource.data && !evidenceText.trim() && !brokerEvidence))
      return { model: null, error: null };
    const market = resource.data
      ? { ...resource.data, ...(episodeState ? { episodes: episodeState } : {}) }
      : {
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
            fx: shocks.fx,
            assets: shocks.assets,
          },
          riskWindow,
          cash,
        ),
        error: null,
      };
    } catch (error) {
      return {
        model: buildPortfolioRisk(portfolio, localTickers, market, null, undefined, riskWindow, cash),
        error: error instanceof Error ? error.message : "Evidence invalid",
      };
    }
  }, [
    frozen,
    portfolio,
    localTickers,
    resource.data,
    episodeState,
    evidenceText,
    brokerEvidence,
    equity,
    rates,
    volatility,
    shocks,
    riskWindow,
    cash,
  ]);
  const model = derived.model;
  const marketLoading = resource.loading && !resource.data;
  // A basket view with nothing to estimate says why in the body, not with a table of dashes.
  const basketBody = useMemo<{ loading?: boolean; error?: string; title?: string; message?: string; noHoldings?: boolean } | null>(() => {
    if (!model || !BASKET_VIEWS.has(view)) return null;
    if (!frozen && !resource.data)
      return marketLoading ? { loading: true } : resource.error ? { error: resource.error } : null;
    if (view === "holdings") return null;
    const shortfall = riskCoverageShortfall(model.coverage);
    // The currency and price shocks reprice the book without the basket, so they stay; the footer says why the basket scenarios do not.
    if (shortfall && view === "stress" && model.rows.stress.some(isShockRow)) return null;
    // A portfolio with no holdings says where they come from, as the other panes' empty states do.
    return shortfall && !model.coverage?.holdings ? { ...shortfall, message: NO_HOLDINGS_HINT, noHoldings: true } : shortfall;
  }, [frozen, marketLoading, model, resource.data, resource.error, view]);
  // Stress with too little covered for the basket scenarios, its shocks shown alone.
  const stressShortfall = useMemo(
    () => (!basketBody && model && view === "stress" ? riskCoverageShortfall(model.coverage) : null),
    [basketBody, model, view],
  );
  const holdingsSummary = useMemo(
    () => view === "holdings" ? holdingsSummaryItems((model?.rows.holdings ?? []).filter((row) => HOLDINGS_SUMMARY_ROW_IDS.has(row.id))) : [],
    [model, view],
  );
  const rows = useMemo(
    () =>
      (basketBody ? [] : model?.rows[view] ?? [])
        .filter((row) => view !== "holdings" || !HOLDINGS_SUMMARY_ROW_IDS.has(row.id))
        .filter((row) => !stressShortfall || isShockRow(row))
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
    [basketBody, stressShortfall, model, view, sort],
  );
  const openRow = rows.find((row) => row.id === open);
  const evidenceMissing = EVIDENCE_VIEWS.has(view) && rows.length === 0;
  // A broker linked to the portfolio may still be sending its account history.
  const evidenceLoading = evidenceMissing && view === "performance" && brokerPerformance.loading;
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
  // The risk rows read their window in their labels, so the footer names how the tail rows are estimated instead of a column.
  const footerEvidence = (view === "risk" ? rows.find((row) => TAIL_ROW_IDS.has(row.id))?.detail : null) ?? sharedEvidence;
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
    ...riskCoverageNotices(model?.coverage),
    ...(model?.notes ?? []),
    // Which holdings an episode replays by proxy, on the view that shows the episodes.
    ...(view === "stress" && !stressShortfall && model?.episodes ? episodeProxyNotes(model.episodes) : []),
    ...(model?.warnings ?? []),
    ...shocks.errors,
    ...(derived.error ? [derived.error] : []),
    ...(resource.error ? [resource.error] : []),
  ];
  // What the basket views cover of the book and leave out, unless the body already says why they show nothing.
  // Stress showing its shocks alone says instead why the basket scenarios are not there.
  const coverageText = !model || !BASKET_VIEWS.has(view) || basketBody
    ? null
    : stressShortfall
      ? `Index, 10Y, VIX and episode scenarios: ${stressShortfall.title.replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase())}`
      : riskCoverageLine(model.coverage);
  const asOfDate = (stressShortfall ? rows : model?.rows[view])?.find((row) => row.asOf)?.asOf?.slice(0, 10) ?? null;
  // The views estimated from returns name the currency a non-USD account's returns were converted into.
  const returnsCurrency = BASKET_VIEWS.has(view) && view !== "holdings" && !stressShortfall ? riskReturnsCurrency(model) : null;
  // Dated evidence only when a row has a date; a missing date is not a claim about history.
  const asOfText = !model
    ? null
    : [
        ...(basketBody ? [] : [
          ...(coverageText ? [coverageText] : []),
          ...(asOfDate && footerEvidence ? [footerEvidence] : []),
          // The coverage names the currency of its basket value; a non-USD account's returns say what they converted into.
          // An evidence view with nothing in it has no amounts for a currency to describe.
          ...(returnsCurrency ? [returnsCurrency] : coverageText || evidenceMissing ? [] : [model.portfolio.currency]),
          ...(EVIDENCE_VIEWS.has(view) && model.evidence ? [model.evidence.source] : []),
        ]),
      ].join(" · ") || null;
  // What the figures are read from and to when: the basket's daily closes, or the marks and evidence of that day.
  // The shocks alone are repriced at the current marks.
  const sourceText = basketBody || !asOfDate
    ? null
    : DAILY_CLOSE_VIEWS.has(view) && !stressShortfall ? `daily closes to ${asOfDate}` : `as of ${asOfDate}`;
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
        ...(resource.loading || (view === "stress" && episodeResource.loading)
          ? [
              {
                id: "loading",
                parts: [
                  { text: "loading history", tone: "muted" as const },
                ],
              },
            ]
          : []),
        // Coverage first: a narrow footer cuts the method and the date before what the numbers cover.
        ...(asOfText
          ? [{ id: "asof", parts: [{ text: asOfText, tone: "muted" as const }] }]
          : []),
        // The source and its date, which a capture's own dated status line stands in for.
        ...(sourceText
          ? [{ id: "source", asOf: true, parts: [{ text: sourceText, tone: "muted" as const }] }]
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
    [resource.loading, view, episodeResource.loading, asOfText, sourceText, actionStatus, hints],
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
  const chart = useMemo<ChartTableChart | null>(() => {
    if (!model) return null;
    if (view === "performance") {
      if (!model.performance) return null;
      return {
        series: [staticSeries(
          model.performance.points.map((row) => scalarPoint(new Date(row.date), (row.wealth - 1) * 100)),
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
        // A tail loss reads in money beside its percent: 2.60% ($5,735).
        width: sharedUnit || attributionParts ? Math.max(9, valueHeader.length) : rows.some((row) => row.amount != null) ? 18 : 16,
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
      ...(width >= 95 && !footerEvidence && !attributionParts
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
    [width, view, valueHeader, sharedUnit, attributionParts, footerEvidence, showPercentile, sharedDate, rows],
  );
  const selectView = (value: string) => {
    setView(value);
    setOpen(null);
    setSelected(null);
  };
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
  // Correlation shows the heat matrix CORR draws while every holding fits the
  // pane under the portfolio bar; a larger basket lists its pairs, strongest first.
  const basketMatrix = useMemo(
    () => (view === "correlation" && model && !basketBody ? basketCorrelationMatrix(model) : null),
    [basketBody, model, view],
  );
  const matrixShown = !!basketMatrix && correlationMatrixFits(basketMatrix.symbols, width, rootHeight - 1);
  const [matrixState, setMatrixState] = useState<{ cursor: MatrixCursor; hoveredSymbol: string | null }>({
    cursor: { row: 0, column: 1 },
    hoveredSymbol: null,
  });
  // The matrix has no row detail: a pair opened from the list closes once the matrix takes its place.
  useEffect(() => {
    if (matrixShown && open) setOpen(null);
  }, [matrixShown, open, setOpen]);
  const matrixSymbols = matrixShown ? basketMatrix!.symbols : [];
  const matrixCursor = clampMatrixCursor(matrixState.cursor, matrixSymbols.length);
  const { pinTicker, navigateTicker } = usePluginTickerActions();
  const openMatrixSymbol = useCallback((symbol: string) => {
    if (tickers.has(symbol)) pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
    else navigateTicker(symbol);
  }, [navigateTicker, pinTicker, tickers]);
  // A pair opens in GR, as it does from CORR; a row label opens its holding.
  const openMatrixSelection = useCallback((selection: [string, string]) => {
    if (selection[0] === selection[1]) openMatrixSymbol(selection[0]);
    else createPaneFromTemplate("relationship-graph-pane", { symbols: selection, arg: formatTickerListInput(selection) });
  }, [createPaneFromTemplate, openMatrixSymbol]);
  const matrixKeys = useCorrelationMatrixKeys({
    symbols: matrixSymbols,
    focused: focused && matrixShown,
    cursor: matrixCursor,
    onCursor: (cursor) => setMatrixState({ cursor, hoveredSymbol: null }),
    onOpen: openMatrixSelection,
    scope: "portfolio-risk:matrix",
  });
  const hoverMatrixSymbol = useCallback((symbol: string) => {
    setMatrixState((current) => ({ ...current, hoveredSymbol: symbol }));
  }, []);
  const leaveMatrixSymbol = useCallback((symbol: string) => {
    setMatrixState((current) => (current.hoveredSymbol === symbol ? { ...current, hoveredSymbol: null } : current));
  }, []);
  if (!portfolio)
    return (
      <EmptyState
        title="No local portfolio."
        hint="Add holdings in PF, then open PORT."
      />
    );
  if (!model)
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
  if (matrixShown)
    return (
      <Box width={width} height={height} flexDirection="column">
        {tabStrip}
        <Box width={width} height={rootHeight} flexDirection="column" overflow="hidden">
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
          <CorrelationMatrixGrid
            symbols={matrixSymbols}
            width={width}
            height={rootHeight - 1}
            correlation={basketMatrix!.correlation}
            cursor={matrixCursor}
            hoveredSymbol={matrixState.hoveredSymbol}
            onSelectCell={(cursor) => {
              setMatrixState({ cursor, hoveredSymbol: null });
              matrixKeys.enter();
            }}
            onHoverSymbol={hoverMatrixSymbol}
            onLeaveSymbol={leaveMatrixSymbol}
            onOpenSymbol={openMatrixSymbol}
          />
        </Box>
      </Box>
    );
  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}
      <DataTableStackView<RiskDisplayRow, DataTableColumn>
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
                  options: portfolios.length
                    ? portfolios.map((row) => ({ value: row.id, label: row.name }))
                    : [{ value: portfolio.id, label: portfolio.name }],
                  onChange: (id: string) => {
                    setPortfolio(id);
                    setOpen(null);
                  },
                }]}
              />
            }
            figures={holdingsSummary}
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
          if (column.id === "value")
            return row.leftOut
              ? { text: "left out", value: null, color: colors.textMuted }
              : { text: sharedUnit || attributionParts ? bareValue(row) : riskValue(row) };
          if (column.id === "percentile") return { text: riskPercentile(row) };
          if (column.id === "asOf") return { text: row.asOf?.slice(0, 10) ?? "--" };
          if (column.id === "allocation" || column.id === "selection" || column.id === "interaction") {
            const part = row[column.id];
            return { text: part == null ? "--" : part.toFixed(2) };
          }
          return { text: row.detail };
        }}
        selectedTextOverridesCellColor
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
        detailScrollRef={detailScrollRef}
        emptyContent={
          basketBody ? (
            <PaneStatusBody
              loading={basketBody.loading}
              error={basketBody.error ?? null}
              empty={!!basketBody.title}
              loadingLabel="Loading portfolio risk"
              emptyTitle={basketBody.title}
              emptyMessage={basketBody.message || undefined}
              actions={basketBody.noHoldings ? <Button label="Open Portfolio" compact onPress={() => showPane("portfolio-list")} /> : undefined}
            />
          ) : evidenceLoading ? (
            <PaneStatusBody loading loadingLabel="Loading account history" />
          ) : evidenceMissing ? (
            <EvidenceEmptyState
              // Each view's own state, so Enter starts on its first action.
              key={view}
              need={evidenceNeed(view, {
                brokerLinked: !!portfolio.brokerInstanceId,
                unvaluedOptions: (model.greeks?.warnings.length ?? 0) > 0,
              })}
              onImport={frozen ? null : () => void importEvidence()}
            />
          ) : undefined
        }
        emptyStateTitle="No comparable observations."
      />
    </Box>
  );
}
