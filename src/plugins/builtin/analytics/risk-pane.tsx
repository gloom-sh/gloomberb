import {
  staticSeries,
  scalarPoint,
} from "../../../components/chart/static/series";
import { loadPortfolioOptionBook } from "./risk-options";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useCallback, useMemo, useState } from "react";
import { Box, ScrollBox, useRendererHost } from "../../../ui";
import {
  CompositeChart,
  DataTableStackView,
  EmptyState,
  KeyValueRow,
  PaneStatusBody,
  StaticChartSurface,
  QueryBar,
  Tabs,
  usePaneHeaderTabs,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableColumn,
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
import type { PaneProps } from "../../../types/plugin";
import { ApiRequestError } from "../../../api-client/errors";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPortfolioRiskMarket } from "./risk-client";
import { parsePortfolioRiskEvidence } from "./risk-evidence";
import {
  buildPortfolioRisk,
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
const chartColors = resolveChartPalette(colors, "positive");
const PANELS = [{ id: "main" }];
// No column: rows keep the model order (return, risk, tail), which reads better than A-Z.
const DEFAULT_SORT = { column: "", direction: "asc" as const };
const EMPTY_MODEL: PortfolioRiskModel | null = null;
const clearDenied = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
function RiskDetail({
  row,
  width,
  height,
}: {
  row: RiskDisplayRow;
  width: number;
  height: number;
}) {
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
    <ScrollBox
      width={width}
      height={height}
      scrollY
      contentOptions={{ paddingX: 1 }}
    >
      <KeyValueRow
        label="Value"
        value={riskValue(row)}
        detail={row.asOf ?? "Source date unavailable"}
      />
      <KeyValueRow label="Percentile 1Y" value={riskPercentile(row)} />
      <KeyValueRow label="Evidence" value={row.detail} />
      {points.filter((row) => Number.isFinite(row.close)).length > 1 && (
        <StaticChartSurface
          points={points}
          width={Math.max(12, width - 2)}
          height={Math.max(5, height - 5)}
          mode="line"
          calendarSpaced
          showTimeAxis
          colors={chartColors}
          yAxisLabel={row.unit}
        />
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
    if (!portfolio || (!resource.data && !evidenceText.trim()))
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
          parsePortfolioRiskEvidence(evidenceText),
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
    equity,
    rates,
    volatility,
  ]);
  const model = derived.model;
  const rows = useMemo(
    () =>
      [...(model?.rows[view] ?? [])].sort((a, b) => {
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
  // The chart takes what the table does not need: view tabs and portfolio bar (2), header, rows and footer.
  const chartHeight =
    series.length && height >= 18
      ? Math.max(0, Math.min(Math.floor(height * 0.6), height - 4 - rows.length - 2))
      : 0;
  const openRow = rows.find((row) => row.id === open);
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
  const notices = [
    ...(model?.warnings ?? []),
    ...(derived.error ? [derived.error] : []),
    ...(resource.error ? [resource.error] : []),
    ...(["performance", "attribution", "greeks"].includes(view) && !rows.length
      ? [
          `${titles[view]} requires dated local evidence. Import version 1 JSON using i.`,
        ]
      : []),
    ...(view === "holdings" || view === "correlation" || view === "stress"
      ? [
          "Historical percentile unavailable for this current composition or scenario.",
        ]
      : []),
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
                  { text: "loading Cloud history", tone: "muted" as const },
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
  const columns = useMemo<DataTableColumn[]>(
    () => [
      {
        id: "label",
        label: "Metric",
        width: Math.min(30, Math.max(19, width - 45)),
        align: "left",
      },
      { id: "value", label: "Value", width: 16, align: "right" },
      ...(showPercentile
        ? [{ id: "percentile", label: "Pctl 1Y", width: 8, align: "right" as const }]
        : []),
      ...(sharedDate
        ? []
        : [{ id: "asOf", label: "As of", width: 11, align: "left" as const }]),
      ...(width >= 95 && !sharedEvidence
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
    [width, sharedEvidence, showPercentile, sharedDate],
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
  // The view strip and the portfolio bar take one row each in the terminal.
  const chromeRows = tabsInHeader ? 1 : 2;
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
      <DataTableStackView<RiskDisplayRow, DataTableColumn>
        focused={focused}
        columns={columns}
        items={rows}
        getItemKey={getKey}
        rootBefore={
          chartHeight ? (
            <CompositeChart
              series={series}
              panels={PANELS}
              width={width}
              height={chartHeight}
              showLegend
              showTimeAxis
              navigable={false}
              formatAxisValue={(value) => `${value.toFixed(1)}%`}
              remoteKind="portfolio-risk-history"
            />
          ) : undefined
        }
        rootHeight={Math.max(3, height - chromeRows)}
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
        renderCell={(row, column) => ({
          text:
            column.id === "label"
              ? row.label
              : column.id === "value"
                ? riskValue(row)
                : column.id === "percentile"
                  ? riskPercentile(row)
                  : column.id === "asOf"
                    ? (row.asOf?.slice(0, 10) ?? "--")
                    : row.detail,
        })}
        onActivate={(row) => setOpen(row.id)}
        detailOpen={!!openRow}
        detailTitle={openRow?.label}
        onBack={() => setOpen(null)}
        detailContent={
          openRow ? (
            <RiskDetail row={openRow} width={width} height={height - 4} />
          ) : null
        }
        emptyStateTitle={
          view === "performance" || view === "attribution" || view === "greeks"
            ? "Import dated local evidence."
            : "No comparable observations."
        }
      />
    </Box>
  );
}
