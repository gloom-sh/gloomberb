import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { createRealizedVolatilityDependencies, loadRealizedVolatilityHistory } from "../realized-vol/client";
import { createHvDependencies, loadIvHistory, loadIvScreen, loadScreenVolatilities } from "./client";
import { formatPoints, formatRank, formatSpot, formatStat, formatVol, IMPLIED_VOL_WORDS, readingLabel, sharedDates, skewHeader, statSource, vcaDefinitions, verdictLabel } from "./format";
import { HV_WINDOWS, type HvWindow, type IvLookback, type IvStatRow, projectIvHistory, projectRichCheap, type RichCheapRow, richCheapDates, screenCoverage, screenStaleNote, VCA_LIMIT, VCA_PRESETS } from "./model";
import { vcaUniverse } from "./universe";
import { offsetText, releaseOffsetRows } from "./events";
import { loadMacroReleases } from "../macro-day/client";
import { MACRO_EVENT_LABELS, MACRO_RELEASE_SOURCES, staleMacroReleasesNotice, US_MACRO_EVENT_KINDS, type MacroRelease, type UsMacroEventKind,
  type MacroReleaseList } from "../macro-day/releases";
import { lookupScheduledDates } from "../alerts/scheduled";
import { fetchCpiBoard } from "../cpi/client";
import { fetchRatePath } from "../rate-path/client";
import type { HeadlessPaneContext } from "../../../types/headless";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { listingFateNotes, listingFateReport, loadListingFate, MovedSymbolError } from "../../../tickers/listing-fate";
import { startTickerChangeLookup } from "../../../tickers/ticker-changes";
import { fxVolatilityRefusal } from "../../../market-data/options-alternatives";

const METHODOLOGY = "docs/research-data.md#implied-volatility-history";
const percent = (value: unknown) => typeof value === "number" ? formatVol(value) : "--";
const points = (value: unknown) => typeof value === "number" ? formatPoints(value) : "--";

export const ivHistoryHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "US option underlying" },
  usListingsOnly: "Implied volatility history",
  refuseSymbol: fxVolatilityRefusal("HIVG"),
  freshness: { status: "not-a-feed", basis: "daily implied volatility", cadence: "daily", observedKey: "date", oldest: null },
  describe: (args) => `HIVG ${args.symbols[0] ?? ""}`,
  discovery: { aliases: ["HIVG"], suggestFor: IMPLIED_VOL_WORDS, screenshotReadiness: "live-dom", dataRequirements: ["Cloud stored implied volatility", "Daily price history"],
    limitations: ["History starts February 2024 (daily option trade closes).", "Rank and percentile use trade-close readings only.",
      "IV1Y needs long-dated trades: it can start later, has gaps, and ranks from 60 prior sessions.",
      "skew25d (put-call) and rr25d (call-put) come from the daily quote captures and are blank before the first one."] },
  options: [
    { key: "lookback", type: "enum", values: [{ value: "1Y" }, { value: "2Y" }, { value: "ALL" }], defaultValue: "1Y", description: "Visible history" },
    { key: "hvWindow", type: "enum", values: HV_WINDOWS.map((window) => ({ value: String(window) })), defaultValue: "20", description: "Realized volatility window in sessions" },
    { key: "event", type: "enum", aliases: ["release"], values: US_MACRO_EVENT_KINDS.map((value) => ({ value, ...value === "jobs" ? { aliases: ["nfp", "payrolls"] } : {} })),
      description: "One row per release of this kind whose session at --offset has closed (the next scheduled FOMC or CPI included), in place of the daily history",
      example: "--event fomc --offset -6", shot: { reportOnly: "lists the readings around past release days" } },
    { key: "offset", type: "integer", minimum: -60, maximum: 60, defaultValue: 0,
      description: "Sessions from each release with --event: 0 is the first session on or after the release day, -6 the sixth session before that",
      example: "--event cpi --offset -1", shot: { reportOnly: "picks the session read around each release" } },
  ],
  async load(args, ctx) {
    const event = typeof args.options.event === "string" && args.options.event ? args.options.event as UsMacroEventKind : null;
    const offset = Number(args.options.offset) || 0;
    if (!event && offset !== 0) throw new Error("--offset counts sessions from a release day: add --event fomc, cpi or jobs.");
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    // What became of the symbol, as `quote` reads it, looked up beside the figures: FB's are the fund listed
    // there now, TWTR stopped trading, and HFC, which became DINO, has none of its own.
    const changes = startTickerChangeLookup(ctx.marketData, instrument.symbol, instrument.exchange);
    const quote = ctx.marketData.getQuote(instrument.symbol, instrument.exchange ?? "").catch(() => null);
    const [payload, prices, releases] = await Promise.all([
      loadIvHistory(instrument.symbol, { signal: ctx.signal }, ctx.apiClient),
      loadRealizedVolatilityHistory({ instrument, signal: ctx.signal }, createRealizedVolatilityDependencies(ctx.marketData)),
      event ? eventReleases(event, ctx) : null,
    ]);
    const fate = await loadListingFate(instrument, ctx.marketData, { quote, changes });
    if (fate.moved) throw new MovedSymbolError(fate.moved);
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
    // With nothing served, the fate is why: no "not a ticker" or missing-history errors beside it.
    const { notes: fateNotes, errors } = listingFateReport(fate, { served },
      [prices.error, ...model.warnings].filter((value): value is string => !!value));
    const notes = [...fateNotes, ...[model.oneYearNote, model.skewNote, model.staleNote].filter((note): note is string => !!note)];
    if (event && releases) {
      const lookback = String(args.options.lookback) as IvLookback;
      const label = MACRO_EVENT_LABELS[event];
      const offsets = releaseOffsetRows(model, releases.list.releases, event, offset, {
        lookback, readThrough: payload.coverage?.backfilledThrough ?? null });
      const plural = (count: number, one: string, many: string) => count === 1 ? one : many;
      const eventNotes = [
        offsets.beforeLookback > 0
          ? `${offsets.beforeLookback} earlier ${label} ${plural(offsets.beforeLookback, "release is", "releases are")} outside the ${lookback} lookback; --lookback ALL adds ${plural(offsets.beforeLookback, "it", "them")}.` : null,
        // Said once the lookback says nothing: the history's own start is then where the rows stop.
        offsets.beforeHistory > 0 && offsets.beforeLookback === 0
          ? `${offsets.beforeHistory} earlier ${label} ${plural(offsets.beforeHistory, "release predates", "releases predate")} the IV history, which starts ${offsets.historyStart}.` : null,
        offsets.pending.length > 0
          ? `Left out ${label} ${offsets.pending.join(", ")}: no closing reading yet for ${plural(offsets.pending.length, "its session", "their sessions")} at --offset ${offset}.` : null,
        releases.upcomingNote,
        staleMacroReleasesNotice(releases.list),
      ].filter((note): note is string => !!note);
      const eventColumns = [{ key: "releaseDate", header: "Release date" }, { key: "session", header: "Session" },
        ...historyColumns.slice(1), ...skewColumns];
      return {
        sections: [{
          title: `${label} releases, ${offsetText(offset)}`,
          // The export names the release and the offset on every row, so files of several offsets or releases join.
          columns: [{ key: "release", header: "Release" }, eventColumns[0]!, { key: "offset", header: "Offset (sessions)" }, ...eventColumns.slice(1)],
          rows: offsets.rows.map(({ date, ...row }) => ({ ...row, session: date, release: label })),
          textColumns: offsets.rows.some((row) => row.skew25d != null) ? eventColumns : eventColumns.slice(0, -skewColumns.length),
        }],
        complete: payload.status === "ready" && errors.length === 0,
        unavailableSymbols: offsets.rows.some((row) => row.iv30 != null) ? [] : [instrument.symbol], errors,
        ...(notes.length + eventNotes.length > 0 ? { notes: [...notes, ...eventNotes] } : {}),
        // Dated by the history read, not by the newest release's session: an old release is no stale reading.
        ...(model.asOf ? { freshness: { asOf: model.asOf } } : {}),
        metadata: { status: payload.status, coverage: payload.coverage, event, offset, releasesThrough: releases.list.coveredThrough,
          nextRelease: releases.upcoming,
          releaseSource: MACRO_RELEASE_SOURCES[event], unit: "decimal annualized volatility", methodology: METHODOLOGY },
      };
    }
    // The text report dates a stale measure "stale"; exports keep the bare date and say it in `stale`.
    const statColumns = [
      { key: "label", header: "Measure" },
      { key: "value", header: "Current", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
      { key: "date", header: "As of" }, { key: "method", header: "Method" },
      { key: "low", header: "52w low", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
      { key: "high", header: "52w high", format: (value: unknown, row?: unknown) => formatStat(value as number | null, (row as IvStatRow).unit) },
      { key: "rank", header: "Rank", format: (value: unknown) => formatRank(value as number | null) },
      { key: "percentile", header: "Pctl", format: (value: unknown) => formatRank(value as number | null) },
      { key: "samples", header: "Sessions" },
    ];
    const statTextColumns = statColumns.map((column) => column.key === "date"
      ? { ...column, textFormat: (value: unknown, row: unknown) => typeof value !== "string" ? "-" : (row as IvStatRow).stale ? `${value} stale` : value }
      : column.key === "method"
        // The wording the pane's source column uses; exports keep the raw method and carry the basis.
        ? { ...column, textFormat: (value: unknown, row: unknown) => typeof value !== "string" ? "-" : statSource(row as IvStatRow) }
        : column);
    return {
      sections: [
        { title: "Statistics", columns: [...statColumns, { key: "basis", header: "Basis" }, { key: "stale", header: "Stale" }], textColumns: statTextColumns,
          rows: model.stats.map((row) => ({ ...row })) },
        // Exports always carry the skew columns, so a script's header never moves; the text table drops them when none has a value.
        { title: "Daily history", columns: [...historyColumns, ...skewColumns], rows,
          ...(rows.some((row) => row.skew25d != null) ? {} : { textColumns: historyColumns }) },
      ],
      complete: payload.status === "ready" && errors.length === 0,
      unavailableSymbols: model.iv30.length ? [] : [instrument.symbol], errors,
      ...(notes.length > 0 ? { notes } : {}),
      // Dated by the newest IV reading, not by the HV row beside it: prices sessions ahead of a stalled IV history
      // must not make it read as current. The daily cadence calls it stale once more than a session has closed since.
      ...(model.asOf ? { freshness: { asOf: model.asOf } } : {}),
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
  refuseSymbol: fxVolatilityRefusal("VCA"),
  options: [{ key: "preset", type: "enum", values: [{ value: "etfs" }, { value: "megacaps" }], defaultValue: "etfs", description: "Preset when no symbols are given" }],
  describe: "Volatility rich/cheap",
  // The pane names its universe `scope`; symbols typed open their own (custom), which a preset does not replace.
  shotState: (args) => args.symbols.length ? {} : { settings: { scope: String(args.options.preset) === "megacaps" ? "megacaps" : "etfs" } },
  discovery: { aliases: ["VCA"], screenshotReadiness: "live-dom", dataRequirements: ["Cloud stored implied volatility", "Daily price history"],
    limitations: ["Rich and cheap are relative to each symbol's own 52 weeks, not a fair-value model."] },
  async load(args, ctx) {
    const universe = args.symbols.length ? vcaUniverse("custom", args.symbols.join(","), null, [])
      : vcaUniverse(String(args.options.preset) === "megacaps" ? "megacaps" : "etfs", "", null, []);
    const screen = loadIvScreen(universe.instruments.map((instrument) => instrument.symbol), { signal: ctx.signal }, ctx.apiClient);
    // A row with no reading says what became of its symbol, as `quote` reads it: TWTR stopped trading, FB is a fund now,
    // and HFC, which became DINO, has no HV of its own.
    const [payload, { hv, fates }] = await Promise.all([
      screen,
      loadScreenVolatilities(universe.instruments, screen.then((loaded) => loaded.rows), 20, { signal: ctx.signal }, createHvDependencies(ctx.marketData)),
    ]);
    // One symbol whose company moved has nothing to screen.
    const [only] = universe.instruments;
    const movedOnly = universe.instruments.length === 1 ? fates.get(only!.symbol)?.moved : null;
    if (movedOnly) throw new MovedSymbolError(movedOnly);
    const rows = projectRichCheap(payload.rows, hv).sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1));
    const noted = new Map(rows.flatMap((row) => {
      const fate = fates.get(row.symbol);
      const note = fate ? listingFateNotes(fate, { served: row.hv != null })[0] : undefined;
      return fate && note ? [[row.symbol, { fate, note }] as const] : [];
    }));
    // A listing that stopped trading has its row's note, not a line saying it has no options history.
    const coverage = screenCoverage(rows, { explained: new Set([...noted].filter(([, entry]) => entry.fate.endedOn).map(([symbol]) => symbol)) });
    const dates = richCheapDates(rows);
    const hasSkew = rows.some((row) => row.riskReversal != null);
    const hasIv1y = rows.some((row) => row.iv1y != null), hasIv1yRank = rows.some((row) => row.iv1yPercentile != null);
    const dated = (value: unknown) => typeof value === "string" ? value : "--";
    return {
      sections: [{ title: ["Rich/cheap", universe.label, ...sharedDates(dates)].join(" · "), columns: [
        { key: "symbol", header: "Symbol" }, { key: "iv30", header: "IV30", format: percent },
        ...(dates.reading ? [] : [{ key: "date", header: "As of", format: (value: unknown, row?: unknown) =>
          typeof value === "string" ? readingLabel(value, (row as RichCheapRow).method, false,
            { basis: (row as RichCheapRow).basis, stale: (row as RichCheapRow).stale }) : "--" }]),
        // The underlying price each reading was taken at, on the date the title or the As of column gives.
        { key: "spot", header: "Spot", format: (value: unknown) => typeof value === "number" ? formatSpot(value) : "--" },
        ...(dates.rankApart ? [{ key: "rankDate", header: "Rank as of", format: (value: unknown) => typeof value === "string" ? `${value} close` : "--" }] : []),
        { key: "rank", header: "IVR", format: (value: unknown) => formatRank(value as number | null) },
        { key: "percentile", header: "IVP", format: (value: unknown) => formatRank(value as number | null) },
        { key: "verdict", header: "Rich/Cheap", format: (value: unknown) => verdictLabel(value as never) },
        ...(hasIv1y ? [{ key: "iv1y", header: "IV1Y", format: percent }] : []),
        ...(hasIv1yRank ? [{ key: "iv1yPercentile", header: "IVP1Y", format: (value: unknown) => formatRank(value as number | null) }] : []),
        { key: "termSlope", header: "30-90", format: (value: unknown) => formatPoints(value as number | null) },
        ...(hasSkew ? [{ key: "riskReversal", header: skewHeader("25D RR", "call-put"), format: (value: unknown) => formatPoints(value as number | null) }] : []),
        ...(hasSkew && dates.skewApart ? [{ key: "skewDate", header: "RR as of", format: dated }] : []),
        { key: "hv", header: "HV20", format: percent },
        // Said only where an HV is not the one of its IV's date: a stale reading's, or one a few sessions off.
        ...(dates.hvApart ? [{ key: "hvDate", header: "HV as of", format: dated }] : []),
        { key: "ivHv", header: "IV/HV", format: (value: unknown) => typeof value === "number" ? value.toFixed(2) : "--" },
        ...(noted.size > 0 ? [{ key: "note", header: "Note", underRow: true }] : []),
      ], rows: rows.map((row) => ({ ...row, ...noted.has(row.symbol) ? { note: noted.get(row.symbol)!.note } : {} })) }],
      // A symbol with no options history is final; only history still to come leaves the screen incomplete.
      complete: !coverage.pending.length && !universe.error, unavailableSymbols: coverage.missing,
      errors: [universe.error].filter((value): value is string => !!value),
      notes: [...coverage.notes, ...[screenStaleNote(rows)].filter((note): note is string => !!note), ...vcaDefinitions({ skew: hasSkew })],
      metadata: { presets: VCA_PRESETS, methodology: METHODOLOGY },
    };
  },
};

/**
 * The releases of `event` HIVG reads around: the days MDAY studies (the list
 * the app ships with, extended by Gloom Cloud's), and the next one scheduled,
 * from the CPI board's release calendar or the FOMC meetings WIRP prices, as
 * scheduled alerts read them. Payrolls have no schedule to read.
 */
async function eventReleases(event: UsMacroEventKind, ctx: HeadlessPaneContext): Promise<{
  list: MacroReleaseList; upcoming: string | null; upcomingNote: string | null;
}> {
  const label = MACRO_EVENT_LABELS[event];
  const [published, next] = await Promise.all([
    loadMacroReleases({}, () => ctx.apiClient.getCloudMacroReleaseDays()),
    event === "jobs" ? null : lookupScheduledDates([{ kind: "macro", event }], {
      earnings: async () => [],
      cpi: () => fetchCpiBoard(ctx.apiClient),
      fomc: async () => (await fetchRatePath(ctx.apiClient)).meetings,
    }, zonedDateKey(Date.now(), "America/New_York")).then((dates) => dates.get(`macro:${event}`) ?? { date: null }),
  ]);
  const upcoming = next && "date" in next ? next.date : null;
  const listed = upcoming != null && published.releases.some((release) => release.kind === event && release.date === upcoming);
  const releases: MacroRelease[] = upcoming && !listed ? [...published.releases, { kind: event, date: upcoming }] : published.releases;
  return {
    list: { ...published, releases },
    upcoming,
    upcomingNote: next == null ? `The next ${label} release is not scheduled here, so it has no row yet.`
      : "error" in next ? `The next ${label} date could not be loaded (${next.error}), so it has no row.` : null,
  };
}
