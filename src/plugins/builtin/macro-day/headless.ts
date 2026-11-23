import { MISSING_VALUE } from "../../../utils/format";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadMacroDayEarnings, loadMacroDayHistory, loadMacroDaySeriesHistory, loadMacroReleases, macroDayEarningsNotice, type MacroDayEarnings } from "./client";
import { fredSeriesArgument } from "../../../series/fred-argument";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import { compareMacroDays, loadMacroDayTarget, MACRO_DAY_DAILY_BASIS, macroDayComparisonHeader, MAX_MACRO_DAY_SYMBOLS, projectMacroDayTargets } from "./comparison";
import { formatMacroDayMove, macroDayEventLabel, macroDayReleaseName, macroDayStats, macroFigureGapNotices, macroSurpriseBasisLabel,
  macroSurpriseExclusionNote, macroSurpriseOf, matchesSurprise, projectMacroDays, type MacroDayEvent, type MacroDayStats } from "./model";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, MACRO_RELEASE_SOURCES, MACRO_SURPRISE_LABELS, MACRO_SURPRISES, staleMacroReleasesNotice,
  US_MACRO_EVENT_KINDS, type MacroEventKind, type MacroReleaseFigures, type MacroSurprise } from "./releases";

// A mean that rounds to zero reads 0.00%, never -0.00%.
const percent = (value: unknown) => typeof value !== "number" ? MISSING_VALUE : /[1-9]/.test((value * 100).toFixed(2)) ? `${(value * 100).toFixed(2)}%` : "0.00%";
const multiple = (value: unknown) => typeof value === "number" ? `${value.toFixed(2)}x` : MISSING_VALUE;
const share = (value: unknown) => typeof value === "number" ? `${Math.round(value * 100)}%` : MISSING_VALUE;

async function loadComparison(args: HeadlessPaneLoadArgs, ctx: HeadlessPaneContext) {
  const [releases, targets] = await Promise.all([loadMacroReleases(), Promise.all(args.symbols.map((symbol) => loadMacroDayTarget(
    symbol, () => resolveHeadlessInstrument(ctx, symbol), { signal: ctx.signal, marketData: ctx.marketData, apiClient: ctx.apiClient },
  )))]);
  ctx.signal.throwIfAborted();
  const models = projectMacroDayTargets(targets, releases, Number(args.options.lookbackYears) || 5);
  const release = String(args.options.release ?? "all");
  const surprise = String(args.options.surprise ?? "all") as MacroSurprise | "all";
  const scoped = compareMacroDays(models).filter((event) => release === "all" || event.kind === release);
  const days = scoped.filter((event) => matchesSurprise(event, surprise));
  const errors = targets.flatMap((target) => target.error ? [`${target.symbol}: ${target.error}`] : []);
  const unavailableSymbols = models.flatMap((model) => model.events.length ? [] : [model.symbol]);
  const notes = [MACRO_DAY_DAILY_BASIS, staleMacroReleasesNotice(releases), macroSurpriseExclusionNote(scoped, surprise),
    ...(days.some((day) => [...day.moves.values()].some((move) => move.earnings)) ? ["* Also an earnings reaction session for this instrument."] : []),
    ...targets.map((target) => target.earningsNotice ? `${target.symbol}: ${target.earningsNotice}` : null),
    ...macroFigureGapNotices(days),
  ].filter((note): note is string => !!note);
  return {
    sections: [{ title: "Release-day moves", columns: [
      { key: "date", header: "Date" }, { key: "release", header: "Release" },
      ...models.map((model) => ({ key: model.symbol, header: macroDayComparisonHeader(model),
        textFormat: (value: unknown, row: Record<string, unknown>) => typeof value === "number"
          ? `${formatMacroDayMove(value / 100, model.basis, { unit: false })}${row[`${model.symbol} earnings`] ? "*" : ""}` : MISSING_VALUE })),
      { key: "actual", header: "Actual" }, { key: "forecast", header: "Forecast" }, { key: "prior", header: "Prior" },
      { key: "surprise", header: "Surprise" },
    ], rows: days.map((day) => ({ date: day.date, release: macroDayEventLabel(day), kind: day.kind,
      actual: day.figures?.actual ?? null, forecast: day.figures?.forecast ?? null, prior: day.figures?.prior ?? null,
      surprise: macroSurpriseOf(day.figures),
      ...Object.fromEntries(models.flatMap(({ symbol }) => {
        const move = day.moves.get(symbol);
        return [[symbol, move ? move.move * 100 : null], [`${symbol} session`, move?.session ?? null], [`${symbol} earnings`, move?.earnings ?? null]];
      })),
    })) }],
    complete: !unavailableSymbols.length && !errors.length && !staleMacroReleasesNotice(releases) && targets.every((target) => !target.stale),
    unavailableSymbols, errors, notes,
    metadata: { basis: MACRO_DAY_DAILY_BASIS, unitBySymbol: Object.fromEntries(models.map(({ symbol, basis }) => [symbol, basis === "yield" ? "bp" : "%"])),
      releasesThrough: releases.coveredThrough, methodology: "docs/research-data.md#macro-day-reaction" },
  };
}

export const macroDayHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "tickers", minimum: 1, maximum: MAX_MACRO_DAY_SYMBOLS,
    description: `Up to ${MAX_MACRO_DAY_SYMBOLS} comma-separated tickers or FRED series`, examples: ["SPY,UUP,^TNX,GLD", "FRED:T10Y2Y"] },
  usListingsOnly: "Macro release day data",
  // Daily closes in the US session, which a line over the counter has as a listed one does.
  usListingsOtc: true,
  // A spread the catalog prints (FRED:T10Y2Y) moves on release days too: its moves in bp.
  fredSeriesArgument: true,
  // Dated by the release list (releasesThrough) as much as by the closes, so no session schedule applies.
  freshness: { status: "not-a-feed", basis: "release-day study on daily closes" },
  describe: (args) => `MDAY ${args.symbols.join(", ")}`,
  discovery: { screenshotReadiness: "live-dom", limitations: [
    `Compare up to ${MAX_MACRO_DAY_SYMBOLS} US listings or FRED series side by side. ${MACRO_DAY_DAILY_BASIS} Moves are in bp for yields and rates, % otherwise.`,
    "Published CPI, jobs and FOMC days, and from Gloom Cloud Brazil's IPCA days, the ECB's decision days (every Governing Council monetary policy meeting) and the BoJ's (each monetary policy meeting's Tokyo day, from 2026); sessions after the list's last covered day (releasesThrough) are left out.",
    "Actual, forecast and prior for the days Gloom Cloud has them (the US headlines from its kept economic calendar, under either feed's title; an FOMC day's are the federal funds target range and whether it held or moved, an ECB day's the deposit facility rate, a BoJ day's its policy rate; IPCA from the central bank's SGS series); --surprise keeps the days that came in hot, cool or in line with the forecast.",
    "A CPI day the calendar lists without its year-on-year actual takes one computed from the CPI index against a year earlier, labelled computed; where none can be (October 2026, as the October 2025 index was never published), its surprise is read from core CPI m/m, else CPI m/m, and named so (hot (core m/m)).",
    "With --surprise, the notes say how many days in scope were left out because their surprise cannot be read (no actual, or no forecast).",
    "A release day without figures says why: before the kept calendar starts, or listed without them.",
    "A release day that is also the reaction session of the company's own earnings report is marked earnings and left out of the release averages and the normal day.",
  ] },
  options: [
    { key: "release", type: "enum", values: [{ value: "all" }, ...MACRO_EVENT_KINDS.map((value) => ({ value }))], defaultValue: "all",
      description: "Release the pane lists", pluginState: { pluginId: "ticker-research", key: "release" } },
    { key: "surprise", type: "enum", values: [{ value: "all" }, ...MACRO_SURPRISES.map((value) => ({ value }))], defaultValue: "all",
      description: "Release days whose print came in above (hot), below (cool) or at (in-line) the forecast",
      example: "--release cpi --surprise hot", pluginState: { pluginId: "ticker-research", key: "surprise" } },
    { key: "lookbackYears", type: "integer", minimum: 1, maximum: 5, defaultValue: 5, description: "Years of daily closes" },
  ],
  async load(args, ctx) {
    if (args.symbols.length > 1) return loadComparison(args, ctx);
    // FRED:T10Y2Y is a series, read from FRED: it has no earnings, and a rate or spread moves by its level.
    const seriesId = fredSeriesArgument(args.symbols[0]!);
    const instrument = seriesId ? null : await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const symbol = instrument?.symbol ?? `FRED:${seriesId}`;
    const [history, releases, earnings] = await Promise.all([
      instrument ? loadMacroDayHistory({ instrument, signal: ctx.signal }, ctx.marketData) : loadMacroDaySeriesHistory({ seriesId: seriesId!, signal: ctx.signal }, ctx.apiClient),
      loadMacroReleases(),
      instrument ? loadMacroDayEarnings({ instrument, signal: ctx.signal }) : Promise.resolve<MacroDayEarnings>({ reports: [], stale: false, error: null }),
    ]);
    const basis = "rate" in history ? history.rate ? "yield" as const : "return" as const : undefined;
    ctx.signal.throwIfAborted();
    const model = projectMacroDays(history.history, { symbol, basis, lookbackYears: Number(args.options.lookbackYears) || 5,
      releases: releases.releases, coveredThrough: releases.coveredThrough, earnings: earnings.reports });
    const notes = [staleMacroReleasesNotice(releases), macroDayEarningsNotice(earnings)].filter((note): note is string => !!note);
    const row = (label: string, stats: MacroDayStats) => ({ label, ...stats });
    // A yield index (^TNX) moves by its level: its columns are headed bp and read the change in the yield.
    const yieldMoves = model.basis === "yield";
    const bp = (signed: boolean) => (value: unknown) => typeof value === "number" ? formatMacroDayMove(value, "yield", { signed, unit: false }) : MISSING_VALUE;
    const move = yieldMoves ? bp(true) : percent;
    const absMove = yieldMoves ? bp(false) : percent;
    const header = (label: string) => yieldMoves ? `${label} bp` : label;
    const release = String(args.options.release ?? "all");
    const surprise = String(args.options.surprise ?? "all") as MacroSurprise | "all";
    const scoped = model.events.filter((event) => release === "all" || event.kind === release);
    const events = scoped.filter((event) => matchesSurprise(event, surprise));
    // A surprise filter says how many days it could not read, and the notes below say why for them too.
    const unread = surprise === "all" ? [] : scoped.filter((event) => macroSurpriseOf(event.figures) == null);
    const excluded = macroSurpriseExclusionNote(scoped, surprise);
    // The days the filter keeps get a row of their own: how the name moved on hot CPI days.
    const selected = surprise === "all" ? [] : [row(`${MACRO_SURPRISE_LABELS[surprise]} ${release === "all" ? "release"
      : MACRO_EVENT_LABELS[release as MacroEventKind]}`, macroDayStats(events, model.normal.meanAbs))];
    // A day without figures says why: before the kept calendar (one note for them all), or the calendar's own gap. An ECB
    // decision before it has its rates (Gloom Cloud reads them off the deposit rate series) and lacks only the forecast.
    const figuresFrom = releases.figuresFrom;
    const predates = (event: MacroDayEvent) => !!figuresFrom && event.kind !== "ipca" && event.date < figuresFrom;
    const beforeCalendar = (event: MacroDayEvent) => predates(event) && !event.figures;
    const noForecast = (event: MacroDayEvent) => predates(event) && !!event.figures && event.figures.forecast == null;
    /** "CPI and Jobs days": the kinds of the listed days `pick` takes, in the order the summary lists them. */
    const noted = [...events, ...unread];
    const daysOf = (pick: (event: MacroDayEvent) => boolean) => {
      const labels = model.kinds.filter((kind) => noted.some((event) => event.kind === kind && pick(event))).map((kind) => MACRO_EVENT_LABELS[kind]);
      return `${labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0]} days`;
    };
    // A release Gloom Cloud alone lists (IPCA, the ECB, the BoJ) is summed up on its own: "Any release" is then the US ones'.
    const usOnly = model.kinds.some((kind) => !US_MACRO_EVENT_KINDS.includes(kind as (typeof US_MACRO_EVENT_KINDS)[number]));
    const missing = (event: MacroDayEvent) => event.figures ? null : event.figuresMissing
      ?? (beforeCalendar(event) ? `before ${figuresFrom}, when Gloom Cloud's economic calendar starts` : null);
    const figureNotes = [
      ...(excluded ? [excluded] : []),
      ...(noted.some(beforeCalendar) ? [`${daysOf(beforeCalendar)} before ${figuresFrom} have no actual, forecast or prior: Gloom Cloud's economic calendar starts then.`] : []),
      ...(noted.some(noForecast) ? [`Forecasts start ${figuresFrom}, with Gloom Cloud's economic calendar: ${daysOf(noForecast)} before it have an actual and prior, no forecast or surprise.`] : []),
      ...macroFigureGapNotices(noted.toSorted((left, right) => right.date.localeCompare(left.date) || left.kind.localeCompare(right.kind))),
    ];
    return {
      sections: [
        { title: "By release", columns: [{ key: "label", header: "Day" }, { key: "count", header: "Days" },
          { key: "meanAbs", header: header("Avg |move|"), format: absMove }, { key: "multiple", header: "vs normal", format: multiple },
          { key: "mean", header: header("Avg move"), format: move }, { key: "hitRate", header: "Up", format: share }],
        rows: [...model.kinds.map((kind) => row(MACRO_EVENT_LABELS[kind], model.byKind[kind])), ...selected,
          row(usOnly ? "Any US release" : "Any release", model.allEvents), ...(model.earnings.count ? [row("Earnings", model.earnings)] : []), row("Normal day", model.normal)] },
        { title: "Release days", columns: [{ key: "date", header: "Date" },
          // The text table reads the decision beside its release (FOMC held), as the pane does; exports keep the two apart.
          { key: "event", header: "Release", textFormat: (_value, row) => macroDayEventLabel({ kind: row.kind as MacroEventKind,
            earnings: row.earnings === true, figures: typeof row.decision === "string" ? { decision: row.decision } as MacroReleaseFigures : null }) },
          // A computed actual (a CPI's year-on-year change from the index) says so beside it; the export keeps the flag apart.
          { key: "actual", header: "Actual", textFormat: (value, row) => typeof value !== "string" ? MISSING_VALUE
            : row.actualComputed === true ? `${value} (computed)` : value },
          { key: "forecast", header: "Forecast" }, { key: "prior", header: "Prior" },
          // A surprise read from another print than the headline's names it: hot (core m/m).
          { key: "surprise", header: "Surprise", textFormat: (value, row) => typeof value !== "string" ? MISSING_VALUE
            : typeof row.surpriseBasis === "string" ? `${value} (${row.surpriseBasis})` : value },
          { key: "session", header: "Session" }, { key: "move", header: header("Move"), format: move }, { key: "multiple", header: "vs normal", format: multiple }],
        rows: events.map((day) => {
          const { figures, figuresMissing: _gap, ...event } = day;
          const why = missing(day);
          return { ...event, event: macroDayReleaseName(day), actual: figures?.actual ?? null,
            forecast: figures?.forecast ?? null, prior: figures?.prior ?? null, surprise: macroSurpriseOf(figures),
            ...(macroSurpriseBasisLabel(figures) ? { surpriseBasis: macroSurpriseBasisLabel(figures),
              surpriseBasisActual: figures!.surpriseBasis!.actual, surpriseBasisForecast: figures!.surpriseBasis!.forecast } : {}),
            ...(figures ? { headline: figures.event } : {}), ...(figures?.decision ? { decision: figures.decision } : {}),
            ...(figures?.computed ? { actualComputed: true, actualBasis: figures.computed } : {}),
            ...(figures?.actualMissing ? { actualMissing: figures.actualMissing } : {}),
            ...(why ? { figuresMissing: why } : {}) };
        }) },
      ],
      complete: !history.stale && !earnings.stale && !history.error && !notes.length && model.events.length > 0,
      unavailableSymbols: model.events.length ? [] : [symbol],
      errors: history.error ? [history.error] : [],
      ...(notes.length || figureNotes.length ? { notes: [...notes, ...figureNotes] } : {}),
      metadata: { unit: yieldMoves ? `change in the ${seriesId ? "rate" : "yield"} in percentage points, close to close on the release day`
        : "decimal return, close to close on the release day", start: model.start, asOf: model.asOf,
        releasesThrough: releases.coveredThrough, releaseSources: Object.values(MACRO_RELEASE_SOURCES),
        stale: history.stale || earnings.stale, fetchedAt: history.fetchedAt, methodology: "docs/research-data.md#macro-day-reaction" },
    };
  },
};
