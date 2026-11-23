import { MISSING_VALUE } from "../../../utils/format";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadSeasonalityHistory } from "./client";
import { closedHistoryBarDay, formingHistoryBar } from "../ticker-detail/data-panes/history-bars";
import { MONTH_LABELS, projectSeasonality, projectWeekdays, TURN_OF_MONTH_LABELS } from "./model";
import { logFailure } from "../../../utils/log-failure";
import type { DataProvider } from "../../../types/data-provider";

const percent = (digits: number) => (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(digits)}%` : MISSING_VALUE;
const statColumns = (digits: number, countHeader: string) => [{ key: "mean", header: "Avg", format: percent(digits) },
  { key: "median", header: "Median", format: percent(digits) }, { key: "hitRate", header: "Up", format: percent(1) }, { key: "count", header: countHeader }];

/** A month running to a named session close is that month to date, through it; a month that has ended is dated by it. */
function closeDayFreshness(closeDay: string, monthRunning: boolean) {
  return monthRunning ? { periodToDate: { period: "month" as const, through: closeDay } } : { asOf: closeDay };
}

/**
 * Without daily closes to name the session, the newest monthly bar dated by its
 * venue's calendar: how far the month has run, or its last session once it has
 * ended. Monthly bars are dated by their month's first day, which is no close
 * while the month runs. Null when there is no bar.
 */
async function monthlyBarFreshness(asOf: Date | null, instrument: { symbol: string; exchange?: string }, marketData: { getQuote: DataProvider["getQuote"] }) {
  const bar = asOf?.toISOString().slice(0, 10);
  if (!bar) return null;
  // The venue whose sessions say whether the month still runs: the key's, or for a bare symbol its quote's.
  const quote = !instrument.exchange ? await marketData.getQuote(instrument.symbol, "").catch(logFailure("seasonality.headless", "Load seasonality quote failed", null)) : null;
  const venue = instrument.exchange || quote?.listingExchangeName || quote?.exchangeName || undefined;
  const forming = formingHistoryBar("1mo", bar, venue, Date.now());
  const closed = forming ? null : closedHistoryBarDay("1mo", bar, venue, Date.now());
  return forming ? { periodToDate: forming } : closed ? { asOf: closed } : null;
}

export const seasonalityHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  // Dated by the session close the running month runs to (`month to date, through Fri 20 Nov 2026`), or the last month's close.
  freshness: { status: "not-a-feed", basis: "monthly closes", maxAgeMinutes: 45 * 24 * 60 },
  describe: (args) => `SEAS ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "live-dom", limitations: ["Local-price closes; dividends and FX are excluded.",
    "Weekdays reads daily closes, which are served for the last five years only."] },
  options: [
    { key: "tab", type: "enum", values: [{ value: "returns" }, { value: "overlay" }, { value: "weekdays" }], defaultValue: "returns",
      description: "Initial view", pluginState: { pluginId: "ticker-research", key: "activeTabId" } },
    { key: "lookbackYears", type: "integer", minimum: 1, maximum: 30, defaultValue: 10, description: "Calendar years, the current one included; Weekdays covers every daily close served" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const weekdays = args.options.tab === "weekdays";
    const history = await loadSeasonalityHistory({ instrument, cadence: weekdays ? "daily" : "monthly", signal: ctx.signal }, ctx.marketData);
    ctx.signal.throwIfAborted();
    const common = { errors: history.error ? [history.error] : [], ...(history.rollNote ? { notes: [history.rollNote] } : {}) };
    if (weekdays) {
      const model = projectWeekdays(history.history, { symbol: instrument.symbol, exchange: instrument.exchange, fetchedAt: history.fetchedAt });
      const present = model.start != null;
      return {
        sections: [
          { title: "By weekday", columns: [{ key: "day", header: "Day" }, ...statColumns(3, "Sessions")],
            rows: model.weekdays },
          { title: "Turn of month", columns: [{ key: "day", header: "Session" }, ...statColumns(3, "Sessions")],
            rows: [...model.turnOfMonth.map((stat, index) => ({ day: TURN_OF_MONTH_LABELS[index], ...stat })),
              { day: "Turn of month", ...model.turnWindow }, { day: "Other days", ...model.otherDays }] },
        ],
        complete: !history.stale && !history.error && present,
        unavailableSymbols: present ? [] : [instrument.symbol],
        ...common,
        // Dated by its last session's close.
        freshness: { basis: "daily closes", maxAgeMinutes: 14 * 24 * 60 },
        metadata: { unit: "decimal return, local-price session close to close", start: model.start, asOf: model.asOf, stale: history.stale,
          fetchedAt: history.fetchedAt, methodology: "docs/research-data.md#seasonality" },
      };
    }
    const lookbackYears = Number(args.options.lookbackYears) || 10;
    const model = projectSeasonality(history.history, { symbol: instrument.symbol, lookbackYears, lastClose: history.lastClose });
    // A lookback past the first month on record says where the years it covers start.
    const coverage = model.historyStart
      ? `History starts ${model.historyStart}, so the ${lookbackYears}-year lookback covers ${model.years.length} calendar year${model.years.length === 1 ? "" : "s"}` : null;
    const freshness = model.closeDay ? closeDayFreshness(model.closeDay, model.runningMonth != null) : await monthlyBarFreshness(model.asOf, instrument, ctx.marketData);
    const monthColumns = MONTH_LABELS.map((label, month) => ({ key: `m${month}`, header: label, format: percent(1) }));
    return {
      sections: [
        { title: "By month", columns: [{ key: "month", header: "Month" }, ...statColumns(1, "Years")],
          rows: model.months.map((stat) => ({ ...stat, month: MONTH_LABELS[stat.month] })) },
        { title: "Monthly returns", columns: [{ key: "year", header: "Year" }, ...monthColumns, { key: "total", header: "Year", format: percent(1) }],
          rows: model.years.map((year) => ({ year: year.year, total: year.total, ...Object.fromEntries(year.months.map((value, month) => [`m${month}`, value])) })) },
      ],
      complete: !history.stale && !history.error && model.years.length > 0,
      unavailableSymbols: model.years.length ? [] : [instrument.symbol],
      ...common,
      ...(coverage ? { notes: [...common.notes ?? [], coverage] } : {}),
      ...(freshness ? { freshness } : {}),
      // The session the newest month runs to, not the first day its monthly bar is dated by.
      metadata: { unit: "decimal return, local-price close to close", asOf: model.closeDay ?? model.asOf?.toISOString() ?? null, stale: history.stale,
        fetchedAt: history.fetchedAt, averagePath: model.averagePath, methodology: "docs/research-data.md#seasonality" },
    };
  },
};
