import { useCallback, useMemo } from "react";
import { Box, TextAttributes } from "../../../ui";
import {
  ChartTableHeader,
  DataTableView,
  spanAxisFormatter,
  useChartTableSelection,
  usePaneStatusFooter,
  usePaneTabs,
  type ChartTableChart,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import type { ChartPanelSpec, ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { blendHex, colors } from "../../../theme/colors";
import { MISSING_VALUE, distributionAmountsDigits, formatDistributionAmount, formatPercentRaw } from "../../../utils/format";
import { formatFilingDate } from "../../../utils/datetime-format";
import { NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { usePaneTicker } from "../../../state/app/context";
import { useAsyncResource } from "../../../react/async-resource";
import { usePlanAccess } from "../../../api-client/plan-access";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { useOpenResearchTab } from "../ticker-detail/research-tab-navigation";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { loadCatalysts } from "../catalysts/client";
import type { TickerResearchTabProps } from "../../../types/plugin-contributions";
import { useEventData } from "./event-data";
import { buildNextUp, formatEventMetric, isFundListing, nextCatalystOf, nextCatalystQuery, type EventSummaryFigure } from "./event-model";
import { dividendYearDetail, dividendYearLabel, dividendYears, dividendYearSpan, earningsQuarters, splitMarks, type DividendYear, type EarningsQuarter } from "./event-charts";

type ViewProps = { focused: boolean; width: number; height: number; footerPaneId?: string };

const DAY_MS = 86_400_000;
const EARNINGS_PANELS: ChartPanelSpec[] = [{ id: "main" }];
const DIVIDEND_PANELS = EARNINGS_PANELS;
const YEAR_TOTAL_DIGITS = 4;

const toStat = (figure: EventSummaryFigure) => ({
  id: figure.id, label: figure.label, value: figure.value,
  ...(figure.detail ? { detail: figure.detail } : {}),
  ...(figure.detailVariants ? { detailVariants: figure.detailVariants } : {}),
  ...(figure.tone ? { tone: figure.tone } : {}),
});

/** The one currency every figure of a column is in, to head it with; none when they differ or one is unstated. */
function sharedCurrency(values: ReadonlyArray<{ value: number | undefined; currency: string | undefined }>): string | undefined {
  const present = values.filter((entry) => entry.value != null);
  const first = present[0]?.currency;
  return first && present.every((entry) => entry.currency === first) ? first : undefined;
}

/**
 * One slot per bar, oldest first, with an empty slot at each end so the outer
 * bars sit inside the plot, as ERN's report bars do.
 */
function slotPoints<T extends { date: string }>(bars: readonly T[], value: (bar: T) => number | null | undefined): TimeSeriesPoint[] {
  if (!bars.length) return [];
  const at = (date: string, days = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  return [
    scalarPoint(at(bars[0]!.date, -1), null),
    ...bars.map((bar) => scalarPoint(at(bar.date), value(bar) ?? null)),
    scalarPoint(at(bars.at(-1)!.date, 1), null),
  ];
}

/** A tick under each bar; where they are too close the axis drops some rather than run them together. */
function slotAxis<T>(bars: readonly T[], label: (bar: T) => string, cursor: (bar: T) => string) {
  const slots = bars.length + 1;
  return {
    ticks: bars.map((bar, index) => ({ label: label(bar), ratio: (index + 1) / slots })),
    formatCursor: (ratio: number) => {
      const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(ratio * slots) - 1))];
      return bar ? cursor(bar) : "";
    },
  };
}

/**
 * The company's next dated catalyst on record (a regulatory decision, a court
 * date), for the opening block. Nothing while it loads, for a plan that does
 * not see the calendar, or when none is ahead; a failed read is the footer's.
 */
function useNextCatalyst(symbol: string | null, enabled: boolean, today: string) {
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  // As the Catalysts view keys its reads: what the calendar answers differs by session and plan.
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const loader = useCallback((force: boolean) => (
    loadCatalysts(nextCatalystQuery(symbol!), accessKey, force).then((result) => nextCatalystOf(result.payload.events, today))
  ), [accessKey, symbol, today]);
  const { data, error, reload } = useAsyncResource(enabled && symbol ? loader : null);
  // Signed out, the Catalysts view says so; the opening block leaves the figure out.
  return { catalyst: data ?? null, error: error && !isCloudSessionRequired(error) ? `Catalysts unavailable: ${error}` : null, reload };
}

type QuarterColumnId = "date" | "period" | "eps" | "estimate" | "surprise" | "revenue" | "detail";
type QuarterColumn = DataTableColumn & { id: QuarterColumnId };

function quarterColumns(width: number, epsUnit: string | undefined, revenueUnit: string | undefined): QuarterColumn[] {
  const heading = (label: string, unit: string | undefined) => (unit ? `${label} ${unit}` : label);
  const columns: QuarterColumn[] = [
    { id: "date", label: "DATE", width: 11, align: "left" },
    { id: "period", label: "QUARTER", width: 9, align: "left" },
    { id: "eps", label: heading("EPS", epsUnit), width: Math.max(7, heading("EPS", epsUnit).length), align: "right" },
    { id: "estimate", label: "EST", width: 7, align: "right" },
    { id: "surprise", label: "SURPRISE", width: 9, align: "right" },
    { id: "revenue", label: heading("REVENUE", revenueUnit), width: Math.max(9, heading("REVENUE", revenueUnit).length), align: "right" },
    { id: "detail", label: "DETAIL", width: 16, align: "left", flexGrow: 1 },
  ];
  return fitChartTableColumns(columns, width, ["detail", "revenue"]);
}

/**
 * The Earnings view of EVT and the Events tab: what is next over a chart of
 * the last quarters, the reported EPS against its estimate with the surprise
 * in the beat or miss colour under it, and the quarters' exact figures in the
 * table, one selection across both.
 */
function EventsEarningsView({ focused, width, height, footerPaneId = "corporate-actions" }: ViewProps) {
  const data = useEventData();
  const { symbol, today, allRows, fund } = data;
  const quarters = useMemo(() => earningsQuarters(allRows, today), [allRows, today]);
  const { catalyst, error: catalystError, reload: reloadCatalyst } = useNextCatalyst(symbol, !fund, today);
  const figures = useMemo(() => buildNextUp(allRows, { today, fund, statedExDate: data.statedExDate, catalyst }).map(toStat),
    [allRows, catalyst, data.statedExDate, fund, today]);
  const epsUnit = sharedCurrency(quarters.flatMap((quarter) => [
    { value: quarter.eps, currency: quarter.epsCurrency }, { value: quarter.estimate, currency: quarter.epsCurrency }]));
  const revenueUnit = sharedCurrency(quarters.map((quarter) => ({ value: quarter.revenue, currency: quarter.revenueCurrency })));
  const columns = useMemo(() => quarterColumns(width, epsUnit, revenueUnit), [epsUnit, revenueUnit, width]);

  const bars = useMemo(() => quarters.toReversed(), [quarters]);
  // Each quarter is its estimate beside what was reported, the reported bar in the beat or miss colour, so a
  // quarter reads at a glance; one with no estimate to measure against (or exactly on it) is the plain EPS bar.
  const series = useMemo<ResolvedSeries[]>(() => {
    if (bars.length < 2) return [];
    const outcome = (quarter: EarningsQuarter) => (quarter.eps == null ? null
      : quarter.estimate == null || quarter.eps === quarter.estimate ? "eps" : quarter.eps > quarter.estimate ? "beat" : "miss");
    const reported = (id: "beat" | "miss" | "eps", label: string, color: string): ResolvedSeries => ({
      ...staticSeries(slotPoints(bars, (quarter) => (outcome(quarter) === id ? quarter.eps : null)), { id, label, color, style: "columns" }),
      unit: epsUnit ?? "", unitGroup: "eps",
    });
    return [
      { ...staticSeries(slotPoints(bars, (quarter) => quarter.estimate), { id: "estimate", label: "Estimate", color: colors.textMuted, style: "columns" }),
        unit: epsUnit ?? "", unitGroup: "eps" },
      reported("beat", "Beat", colors.positive),
      reported("miss", "Miss", colors.negative),
      ...(bars.some((quarter) => outcome(quarter) === "eps") ? [reported("eps", "EPS", colors.textBright)] : []),
    ];
  }, [bars, epsUnit]);
  const axis = useMemo(() => slotAxis(bars, (quarter) => quarter.axisLabel, (quarter) => quarter.period), [bars]);

  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("earningsQuarter", null);
  // Until one is picked, the next report, else the latest one.
  const selected = quarters.find((quarter) => quarter.id === selectedKey) ?? quarters[0] ?? null;
  const link = useChartTableSelection({
    rows: quarters, getId: (quarter) => quarter.id, getDate: (quarter) => new Date(`${quarter.date}T00:00:00Z`),
    selectedId: selected?.id ?? null, onSelect: setSelectedKey, focused,
  });
  const formatEpsAxis = useMemo(() => spanAxisFormatter((value, digits) => value.toFixed(digits), 2), []);
  const chart = useMemo<ChartTableChart | null>(() => series.length ? {
    series, panels: EARNINGS_PANELS, xAxis: axis, remoteKind: "events-earnings", ...link,
    formatValue: (value) => formatEventMetric(value, undefined, "eps"), formatAxisValue: formatEpsAxis,
  } : null, [axis, formatEpsAxis, link, series]);

  const futureRowBackground = blendHex(colors.bg, colors.positive, 0.16);
  const renderCell = useCallback((quarter: EarningsQuarter, column: QuarterColumn): DataTableCell => {
    const metric = (value: number | undefined, currency: string | undefined, unit: string | undefined, kind: "eps" | "revenue") =>
      formatEventMetric(value, unit ? undefined : currency, kind);
    switch (column.id) {
      case "date": return { text: formatFilingDate(quarter.date, quarter.date), value: quarter.date, color: colors.textDim };
      case "period": return { text: quarter.period, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "eps": return { text: quarter.upcoming ? "" : metric(quarter.eps, quarter.epsCurrency, epsUnit, "eps"), ...(quarter.eps != null ? { value: quarter.eps } : {}), color: colors.text };
      case "estimate": return { text: metric(quarter.estimate, quarter.epsCurrency, epsUnit, "eps"), ...(quarter.estimate != null ? { value: quarter.estimate } : {}), color: colors.textDim };
      case "surprise": {
        if (quarter.upcoming) return { text: "" };
        if (quarter.surpriseNotMeaningful) return { text: NOT_MEANINGFUL_TEXT, color: colors.textDim };
        const surprise = quarter.surprisePercent;
        return { text: surprise == null ? MISSING_VALUE : formatPercentRaw(surprise), ...(surprise != null ? { value: surprise } : {}),
          color: surprise == null ? colors.textDim : surprise > 0 ? colors.positive : surprise < 0 ? colors.negative : colors.textDim };
      }
      case "revenue": return { text: quarter.upcoming ? "" : metric(quarter.revenue, quarter.revenueCurrency, revenueUnit, "revenue"), ...(quarter.revenue != null ? { value: quarter.revenue } : {}), color: colors.text };
      case "detail": return { text: quarter.detail, color: colors.textDim };
    }
  }, [epsUnit, revenueUnit]);

  usePaneStatusFooter({ registrationId: footerPaneId, loading: data.loading,
    error: data.error ?? (data.sourceNotice?.failed ? data.sourceNotice.text : null) ?? catalystError });
  // A refresh asks the catalyst calendar again too, so a failed read does not outlast it.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, () => { data.reload(); reloadCatalyst(); }, { stopPropagation: true }),
    [data.reload, reloadCatalyst]);
  if (data.authWall) return <SignInWall placement="corporate-actions-signin" action="view corporate actions" needsVerification={data.cloudSession.needsVerification} />;

  return (
    <DataTableView<EarningsQuarter, QuarterColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={quarters}
      getItemKey={(quarter) => quarter.id}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      sortColumnId={null}
      sortDirection="desc"
      resetScrollKey={symbol ?? ""}
      onRootKeyDown={handleKeyDown}
      getRowBackgroundColor={(quarter) => (quarter.upcoming ? futureRowBackground : undefined)}
      selection={{ kind: "index", selectedIndex: selected ? quarters.indexOf(selected) : -1, onChange: (index) => setSelectedKey(quarters[index]?.id ?? null) }}
      getExportMetadata={() => [...(epsUnit ? [["EPS currency", epsUnit]] : []), ...(revenueUnit ? [["Revenue currency", revenueUnit]] : [])]}
      status={{ loading: data.loading && !quarters.length, error: !data.loading && !quarters.length ? data.error : null, subject: "earnings" }}
      emptyStateTitle={data.sourceNotice?.text ?? "No reported earnings"}
      rootBefore={figures.length || chart ? (
        <ChartTableHeader width={width} height={height} tableRows={quarters.length} tableColumns={columns} figures={figures} chart={chart} />
      ) : undefined}
    />
  );
}

type YearColumnId = "year" | "paid" | "special" | "payments" | "change" | "detail";
type YearColumn = DataTableColumn & { id: YearColumnId };

/**
 * The Dividends view: the ex-date next or last, then one bar per year of what
 * was paid, a special beside it in its own colour and the year not over yet
 * in a muted one, over the years' totals and the splits that went ex in them.
 * Each payment is DVD's: Enter opens it.
 */
export function EventsDividendsView({ focused, width, height, footerPaneId = "corporate-actions:dividends" }: ViewProps) {
  const data = useEventData();
  const { symbol, ticker, today, allRows, actionsData } = data;
  const currency = actionsData?.currency ?? data.currency ?? "";
  const years = useMemo(() => dividendYears(actionsData?.dividends ?? [], today, splitMarks(allRows)), [actionsData?.dividends, allRows, today]);
  // A year's total to one count of decimals, at most four: a sum needs no more to compare years by.
  const digits = useMemo(() => Math.min(YEAR_TOTAL_DIGITS,
    distributionAmountsDigits(years.flatMap((year) => (year.total == null ? [] : [year.total])), currency || "USD")), [currency, years]);
  const amount = useCallback((value: number) => (currency ? formatDistributionAmount(value, currency, digits) : value.toFixed(digits)), [currency, digits]);
  const figures = useMemo(() => {
    const exDate = buildNextUp(allRows, { today, fund: true, statedExDate: data.statedExDate }).map(toStat);
    const full = years.find((year) => !year.partial && year.total != null);
    const current = years.find((year) => year.partial && year.total != null);
    const paying = years.filter((year) => year.total != null);
    const first = paying.at(-1);
    return [
      ...exDate,
      ...(current ? [{ id: "so-far", label: `${current.year} so far`, value: amount(current.total!),
        detail: `${current.payments} ${current.payments === 1 ? "payment" : "payments"}` }] : []),
      ...(full ? [{ id: "last-year", label: `${full.year} paid`, value: amount(full.total!),
        ...(full.change != null ? { detail: `${formatPercentRaw(full.change * 100)} y/y` } : {}) }] : []),
      ...(first ? [{ id: "since", label: "Paying since", value: String(first.year),
        detail: `${paying.length} of ${dividendYearSpan(years)} years` }] : []),
    ];
  }, [allRows, amount, data.statedExDate, today, years]);

  const bars = useMemo(() => years.toReversed().map((year) => ({ ...year, date: `${year.year}-07-01` })), [years]);
  const hasSpecial = years.some((year) => year.special > 0);
  const series = useMemo<ResolvedSeries[]>(() => bars.length < 2 ? [] : [
    { ...staticSeries(slotPoints(bars, (year) => (year.partial || year.total == null ? null : year.total - year.special)),
      { id: "paid", label: "Paid", color: colors.textBright, style: "columns" }), unit: currency, unitGroup: "dividend" },
    ...(hasSpecial ? [{ ...staticSeries(slotPoints(bars, (year) => (year.special > 0 ? year.special : null)),
      { id: "special", label: "Special", color: colors.warning, style: "columns" }), unit: currency, unitGroup: "dividend" }] : []),
    ...(bars.at(-1)?.partial ? [{ ...staticSeries(slotPoints(bars, (year) => (year.partial ? year.total : null)),
      { id: "so-far", label: "So far", color: colors.textMuted, style: "columns" }), unit: currency, unitGroup: "dividend" }] : []),
  ], [bars, currency, hasSpecial]);
  const axis = useMemo(() => slotAxis(bars, (year) => (year.partial ? String(year.year) : dividendYearLabel(year)),
    (year) => (year.partial ? `${year.year} so far` : dividendYearLabel(year))), [bars]);
  const columns = useMemo<YearColumn[]>(() => fitChartTableColumns<YearColumn>([
    { id: "year", label: "YEAR", width: 9, align: "left" },
    { id: "paid", label: currency ? `PAID ${currency}` : "PAID", width: 12, align: "right" },
    ...(hasSpecial ? [{ id: "special" as const, label: "SPECIAL", width: 12, align: "right" as const }] : []),
    { id: "payments", label: "PAYMENTS", width: 8, align: "right" },
    { id: "change", label: "CHANGE", width: 8, align: "right" },
    { id: "detail", label: "DETAIL", width: 12, align: "left", flexGrow: 1 },
  ], width, ["detail", "change"]), [currency, hasSpecial, width]);

  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("dividendYear", null);
  const selected = years.find((year) => year.id === selectedKey) ?? years[0] ?? null;
  const link = useChartTableSelection({
    rows: years, getId: (year) => year.id, getDate: (year) => new Date(`${year.year}-07-01T00:00:00Z`),
    selectedId: selected?.id ?? null, onSelect: setSelectedKey, focused,
  });
  const formatAmountAxis = useMemo(() => spanAxisFormatter((value, places) => value.toFixed(Math.max(2, places)), 2), []);
  const chart = useMemo<ChartTableChart | null>(() => series.length ? {
    series, panels: DIVIDEND_PANELS, xAxis: axis, remoteKind: "events-dividends", ...link,
    formatValue: (value) => amount(value), formatAxisValue: formatAmountAxis,
  } : null, [amount, axis, formatAmountAxis, link, series]);

  const renderCell = useCallback((year: DividendYear, column: YearColumn): DataTableCell => {
    switch (column.id) {
      case "year": return { text: dividendYearLabel(year), value: year.year, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "paid": return year.total == null ? { text: "" } : { text: year.total.toFixed(digits), value: year.total, color: colors.text };
      case "special": return year.special > 0 ? { text: amount(year.special), value: year.special, color: colors.warning } : { text: "" };
      case "payments": return { text: year.payments ? String(year.payments) : "", value: year.payments, color: colors.textDim };
      case "detail": return { text: dividendYearDetail(year), color: colors.textDim };
      case "change": return year.change == null ? { text: "" }
        : { text: formatPercentRaw(year.change * 100), value: year.change * 100, color: year.change > 0 ? colors.positive : year.change < 0 ? colors.negative : colors.textDim };
    }
  }, [amount, digits]);

  const { createPaneFromTemplate } = usePluginAppActions();
  const openResearchTab = useOpenResearchTab();
  // Each payment is DVD's: in Ticker Research its Dividends view, elsewhere a pane of its own.
  const openDividends = useCallback(() => {
    if (openResearchTab?.("dividend-yield")) return;
    if (symbol) createPaneFromTemplate("dividend-yield-pane", { symbol, symbols: [symbol], ...(ticker ? { ticker } : {}) });
  }, [createPaneFromTemplate, openResearchTab, symbol, ticker]);

  usePaneStatusFooter({ registrationId: footerPaneId, loading: data.loading, error: data.error });
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, data.reload, { stopPropagation: true }), [data.reload]);
  if (data.authWall) return <SignInWall placement="corporate-actions-signin" action="view corporate actions" needsVerification={data.cloudSession.needsVerification} />;

  return (
    <DataTableView<DividendYear, YearColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={years}
      getItemKey={(year) => year.id}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      sortColumnId={null}
      sortDirection="desc"
      resetScrollKey={symbol ?? ""}
      onRootKeyDown={handleKeyDown}
      onActivate={openDividends}
      selection={{ kind: "index", selectedIndex: selected ? years.indexOf(selected) : -1, onChange: (index) => setSelectedKey(years[index]?.id ?? null) }}
      getExportMetadata={() => (currency ? [["Currency", currency]] : [])}
      status={{ loading: data.loading && !years.length, error: !data.loading && !years.length ? data.error : null, subject: "dividends" }}
      emptyStateTitle="No dividends on record"
      rootBefore={figures.length || chart ? (
        <ChartTableHeader width={width} height={height} tableRows={years.length} tableColumns={columns} figures={figures} chart={chart} />
      ) : undefined}
    />
  );
}

/** Ticker Research's Earnings view: a fund has none, so its Events tab opens on its distributions. */
export function EventsResearchEarnings(props: TickerResearchTabProps) {
  const fund = useFundListing();
  return fund ? <EventsDividendsView {...props} /> : <EventsEarningsView {...props} />;
}

function useFundListing(): boolean {
  const { financials } = usePaneTicker();
  const quoteType = financials?.quote?.instrumentType;
  const metadataType = financials?.quoteMetadata?.instrumentType;
  return isFundListing(quoteType || metadataType ? {
    quarterlyStatements: [],
    quote: quoteType ? { currency: financials?.quote?.currency ?? "", instrumentType: quoteType } : null,
    quoteMetadata: metadataType ? { instrumentType: metadataType } : null,
  } : null);
}

const EVENT_VIEWS = [{ value: "earnings", label: "Earnings" }, { value: "dividends", label: "Dividends" }];
// A fund reports no earnings: its strip keeps both views, Earnings not to be picked.
const FUND_EVENT_VIEWS = [{ ...EVENT_VIEWS[0]!, disabled: true }, EVENT_VIEWS[1]!];

/**
 * EVT on its own: its Earnings and Dividends views under one strip, there from
 * the first frame whatever loads or fails. A fund opens on its distributions.
 */
export function EventsPane({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const fund = useFundListing();
  const [view, setView] = usePluginPaneState<string>("eventsView", "earnings");
  const shown = fund || view === "dividends" ? "dividends" : "earnings";
  const { strip, rows } = usePaneTabs({ tabs: fund ? FUND_EVENT_VIEWS : EVENT_VIEWS, activeValue: shown, onSelect: setView, focused, dense: true });
  const bodyHeight = Math.max(1, height - rows);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {strip}
      {shown === "dividends"
        ? <EventsDividendsView focused={focused} width={width} height={bodyHeight} />
        : <EventsEarningsView focused={focused} width={width} height={bodyHeight} />}
    </Box>
  );
}
