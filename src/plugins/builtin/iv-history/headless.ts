import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createRealizedVolatilityDependencies, loadRealizedVolatilityHistory } from "../realized-vol/client";
import { createHvDependencies, loadIvHistory, loadIvScreen, loadRealizedVolatilities } from "./client";
import { formatPoints, formatRank, formatSpot, formatStat, formatVol, readingLabel, sharedDates, skewHeader, VCA_DEFINITIONS, verdictLabel } from "./format";
import { HV_WINDOWS, type HvWindow, type IvLookback, type IvStatRow, projectIvHistory, projectRichCheap, type RichCheapRow, richCheapDates, screenCoverage, VCA_LIMIT, VCA_PRESETS } from "./model";
import { vcaUniverse } from "./universe";
import { listingFateNotes, loadListingFate } from "../../../cli/listing-arg";

const METHODOLOGY = "docs/research-data.md#implied-volatility-history";
/** VCA rows with nothing to show whose symbol's fate it looks up; a long list of them is a backfill, not a lookup. */
const MAX_FATE_LOOKUPS = 10;
const percent = (value: unknown) => typeof value === "number" ? formatVol(value) : "--";
const points = (value: unknown) => typeof value === "number" ? formatPoints(value) : "--";

export const ivHistoryHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "US option underlying" },
  usListingsOnly: "Implied volatility history",
  freshness: { status: "not-a-feed", basis: "daily implied volatility", cadence: "daily", observedKey: "date", oldest: null },
  describe: (args) => `HIVG ${args.symbols[0] ?? ""}`,
  discovery: { aliases: ["HIVG"], screenshotReadiness: "live-dom", dataRequirements: ["Cloud stored implied volatility", "Daily price history"],
    limitations: ["History starts February 2024 (daily option trade closes).", "Rank and percentile use trade-close readings only.",
      "IV1Y needs long-dated trades: it can start later, has gaps, and ranks from 60 prior sessions.",
      "skew25d (put-call) and rr25d (call-put) come from the daily quote captures and are blank before the first one."] },
  options: [
    { key: "lookback", type: "enum", values: [{ value: "1Y" }, { value: "2Y" }, { value: "ALL" }], defaultValue: "1Y", description: "Visible history" },
    { key: "hvWindow", type: "enum", values: HV_WINDOWS.map((window) => ({ value: String(window) })), defaultValue: "20", description: "Realized volatility window in sessions" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const [payload, prices, fate] = await Promise.all([
      loadIvHistory(instrument.symbol, { signal: ctx.signal }, ctx.apiClient),
      loadRealizedVolatilityHistory({ instrument, signal: ctx.signal }, createRealizedVolatilityDependencies(ctx.marketData)),
      // What became of the symbol, as `quote` reads it: FB's figures are the fund listed there now, TWTR stopped trading.
      loadListingFate(instrument, ctx.marketData),
    ]);
    const model = projectIvHistory(payload, prices.history, { lookback: String(args.options.lookback) as IvLookback,
      hvWindow: (Number(args.options.hvWindow) === 30 ? 30 : 20) as HvWindow });
    const hvByDay = new Map(model.hv.map((point) => [point.date.getTime(), point.value]));
    const iv365ByDay = new Map(model.iv365.map((point) => [point.date.getTime(), point.value]));
    const skewByDay = new Map(model.skew.map((point) => [point.date.getTime(), point.value]));
    const rows = model.iv30.map((point, index) => {
      const skew = skewByDay.get(point.date.getTime()) ?? null;
      return { date: point.date.toISOString().slice(0, 10), iv30: point.value,
        iv90: model.iv90.find((entry) => entry.date.getTime() === point.date.getTime())?.value ?? null,
        iv365: iv365ByDay.get(point.date.getTime()) ?? null,
        hv: hvByDay.get(point.date.getTime()) ?? null, spread: model.spread[index]?.value ?? null,
        // The same capture's wings, signed both ways so either convention matches without arithmetic.
        skew25d: skew, rr25d: skew == null ? null : -skew };
    }).reverse();
    const historyColumns = [{ key: "date", header: "Session" },
      ...[["iv30", "IV30"], ["iv90", "IV90"], ["iv365", "IV1Y"], ["hv", "HV"]].map(([key, header]) => ({ key: key!, header: header!, format: percent })),
      { key: "spread", header: "IV-HV", format: points }];
    const skewColumns = [{ key: "skew25d", header: skewHeader("skew25d", "put-call"), format: points },
      { key: "rr25d", header: skewHeader("rr25d", "call-put"), format: points }];
    const served = model.iv30.length > 0 || prices.history.length > 0;
    const fateNotes = listingFateNotes(fate, { served });
    // With nothing served, the fate is why: no "not a ticker" or missing-history errors beside it.
    const errors = !served && fateNotes.length > 0 ? []
      : [prices.error, ...model.warnings].filter((value): value is string => !!value);
    const notes = [...fateNotes, ...[model.oneYearNote, model.skewNote].filter((note): note is string => !!note)];
    return {
      sections: [
        { title: "Statistics", columns: [
          { key: "label", header: "Measure" },
          { key: "value", header: "Current", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
          { key: "date", header: "As of" }, { key: "method", header: "Method" },
          { key: "low", header: "52w low", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
          { key: "high", header: "52w high", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
          { key: "rank", header: "Rank", format: (value: unknown) => formatRank(value as number | null) },
          { key: "percentile", header: "Pctl", format: (value: unknown) => formatRank(value as number | null) },
          { key: "samples", header: "Sessions" },
        ], rows: model.stats.map((row) => ({ ...row })) },
        // Exports always carry the skew columns, so a script's header never moves; the text table drops them when none has a value.
        { title: "Daily history", columns: [...historyColumns, ...skewColumns], rows,
          ...(rows.some((row) => row.skew25d != null) ? {} : { textColumns: historyColumns }) },
      ],
      complete: payload.status === "ready" && errors.length === 0,
      unavailableSymbols: model.iv30.length ? [] : [instrument.symbol], errors,
      ...(notes.length > 0 ? { notes } : {}),
      metadata: { status: payload.status, coverage: payload.coverage, latest: payload.latest, stats: payload.stats,
        skewSince: model.skewSince, unit: "decimal annualized volatility", methodology: METHODOLOGY },
    };
  },
};

export const ivScreenHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  // Dated by the readings themselves; the response's own date is the day it was fetched.
  freshness: { status: "not-a-feed", basis: "daily implied volatility", cadence: "daily", observedKey: "date" },
  argument: { kind: "symbol-list", optional: true, maximum: VCA_LIMIT, description: "US option underlyings; defaults to index and sector ETFs." },
  usListingsOnly: "Implied volatility",
  options: [{ key: "preset", type: "enum", values: [{ value: "etfs" }, { value: "megacaps" }], defaultValue: "etfs", description: "Preset when no symbols are given" }],
  describe: "Volatility rich/cheap",
  discovery: { aliases: ["VCA"], screenshotReadiness: "live-dom", dataRequirements: ["Cloud stored implied volatility", "Daily price history"],
    limitations: ["Rich and cheap are relative to each symbol's own 52 weeks, not a fair-value model."] },
  async load(args, ctx) {
    const universe = args.symbols.length ? vcaUniverse("custom", args.symbols.join(","), null, [])
      : vcaUniverse(String(args.options.preset) === "megacaps" ? "megacaps" : "etfs", "", null, []);
    const [payload, hv] = await Promise.all([
      loadIvScreen(universe.instruments.map((instrument) => instrument.symbol), { signal: ctx.signal }, ctx.apiClient),
      loadRealizedVolatilities(universe.instruments, 20, { signal: ctx.signal }, createHvDependencies(ctx.marketData)),
    ]);
    const rows = projectRichCheap(payload.rows, hv).sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1));
    // A row with no reading says what became of its symbol, as `quote` reads it: TWTR stopped trading, FB is a fund now.
    const unread = rows.filter((row) => row.iv30 == null && row.date == null).slice(0, MAX_FATE_LOOKUPS);
    const fates = await Promise.all(unread.map(async (row) => {
      const fate = await loadListingFate({ symbol: row.symbol }, ctx.marketData);
      return [row.symbol, { fate, note: listingFateNotes(fate, { served: row.hv != null })[0] ?? null }] as const;
    }));
    const noted = new Map(fates.filter(([, entry]) => entry.note));
    // A listing that stopped trading has its row's note, not a line saying it has no options history.
    const coverage = screenCoverage(rows, { explained: new Set([...noted].filter(([, entry]) => entry.fate.endedOn).map(([symbol]) => symbol)) });
    const dates = richCheapDates(rows);
    const hasSkew = rows.some((row) => row.skew != null);
    const hasIv1y = rows.some((row) => row.iv1y != null), hasIv1yRank = rows.some((row) => row.iv1yPercentile != null);
    const dated = (value: unknown) => typeof value === "string" ? value : "--";
    return {
      sections: [{ title: ["Rich/cheap", universe.label, ...sharedDates(dates)].join(" · "), columns: [
        { key: "symbol", header: "Symbol" }, { key: "iv30", header: "IV30", format: percent },
        ...(dates.reading ? [] : [{ key: "date", header: "As of", format: (value: unknown, row?: unknown) =>
          typeof value === "string" ? readingLabel(value, (row as RichCheapRow).method) : "--" }]),
        // The underlying price each reading was taken at, on the date the title or the As of column gives.
        { key: "spot", header: "Spot", format: (value: unknown) => typeof value === "number" ? formatSpot(value) : "--" },
        ...(dates.rankApart ? [{ key: "rankDate", header: "Rank as of", format: (value: unknown) => typeof value === "string" ? `${value} close` : "--" }] : []),
        { key: "rank", header: "IVR", format: (value: unknown) => formatRank(value as number | null) },
        { key: "percentile", header: "IVP", format: (value: unknown) => formatRank(value as number | null) },
        { key: "verdict", header: "Rich/Cheap", format: (value: unknown) => verdictLabel(value as never) },
        ...(hasIv1y ? [{ key: "iv1y", header: "IV1Y", format: percent }] : []),
        ...(hasIv1yRank ? [{ key: "iv1yPercentile", header: "IVP1Y", format: (value: unknown) => formatRank(value as number | null) }] : []),
        { key: "termSlope", header: "30-90", format: (value: unknown) => formatPoints(value as number | null) },
        ...(hasSkew ? [{ key: "skew", header: skewHeader("25D skew", "put-call"), format: (value: unknown) => formatPoints(value as number | null) }] : []),
        ...(hasSkew && dates.skewApart ? [{ key: "skewDate", header: "Skew as of", format: dated }] : []),
        { key: "hv", header: "HV20", format: percent },
        { key: "ivHv", header: "IV/HV", format: (value: unknown) => typeof value === "number" ? value.toFixed(2) : "--" },
        ...(noted.size > 0 ? [{ key: "note", header: "Note", underRow: true }] : []),
      ], rows: rows.map((row) => ({ ...row, ...noted.has(row.symbol) ? { note: noted.get(row.symbol)!.note } : {} })) }],
      // A symbol with no options history is final; only history still to come leaves the screen incomplete.
      complete: !coverage.pending.length && !universe.error, unavailableSymbols: coverage.missing,
      errors: [universe.error].filter((value): value is string => !!value),
      notes: [...coverage.notes, ...VCA_DEFINITIONS],
      metadata: { presets: VCA_PRESETS, methodology: METHODOLOGY },
    };
  },
};
