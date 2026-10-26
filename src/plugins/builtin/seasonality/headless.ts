import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadSeasonalityHistory } from "./client";
import { closedHistoryBarDay, formingHistoryBar } from "../ticker-detail/data-panes/history-bars";
import { MONTH_LABELS, projectSeasonality, projectWeekdays, TURN_OF_MONTH_LABELS } from "./model";

const percent = (digits: number) => (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(digits)}%` : "--";
const statColumns = (digits: number, countHeader: string) => [{ key: "mean", header: "Avg", format: percent(digits) },
  { key: "median", header: "Median", format: percent(digits) }, { key: "hitRate", header: "Up", format: percent(1) }, { key: "count", header: countHeader }];

export const seasonalityHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  // Dated by its last monthly close, or by how far the running month's bar runs (`month to date, through Fri 23 Oct 2026`).
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
    const common = { errors: history.error ? [history.error] : [] };
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
    const model = projectSeasonality(history.history, { symbol: instrument.symbol, lookbackYears: Number(args.options.lookbackYears) || 10 });
    // Monthly bars are dated by their month's first day, which is no close while the month runs.
    const bar = model.asOf?.toISOString().slice(0, 10);
    // The venue whose sessions say whether the month still runs: the key's, or for a bare symbol its quote's.
    const quote = bar && !instrument.exchange ? await ctx.marketData.getQuote(instrument.symbol, "").catch(() => null) : null;
    const venue = instrument.exchange || quote?.listingExchangeName || quote?.exchangeName || undefined;
    const forming = formingHistoryBar("1mo", bar, venue, Date.now());
    const closed = forming ? null : closedHistoryBarDay("1mo", bar, venue, Date.now());
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
      ...(forming ? { freshness: { periodToDate: forming } } : closed ? { freshness: { asOf: closed } } : {}),
      metadata: { unit: "decimal return, local-price close to close", asOf: model.asOf?.toISOString() ?? null, stale: history.stale,
        fetchedAt: history.fetchedAt, averagePath: model.averagePath, methodology: "docs/research-data.md#seasonality" },
    };
  },
};
