import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadMacroDayEarnings, loadMacroDayHistory, loadMacroReleases, macroDayEarningsNotice } from "./client";
import { formatMacroDayMove, macroDayEventLabel, macroDayStats, matchesSurprise, projectMacroDays, type MacroDayStats } from "./model";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, MACRO_RELEASE_SOURCES, MACRO_SURPRISE_LABELS, MACRO_SURPRISES, staleMacroReleasesNotice,
  type MacroEventKind, type MacroSurprise } from "./releases";

// A mean that rounds to zero reads 0.00%, never -0.00%.
const percent = (value: unknown) => typeof value !== "number" ? "--" : /[1-9]/.test((value * 100).toFixed(2)) ? `${(value * 100).toFixed(2)}%` : "0.00%";
const multiple = (value: unknown) => typeof value === "number" ? `${value.toFixed(2)}x` : "--";
const share = (value: unknown) => typeof value === "number" ? `${Math.round(value * 100)}%` : "--";

export const macroDayHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  usListingsOnly: "Macro release day data",
  // Dated by the release list (releasesThrough) as much as by the closes, so no session schedule applies.
  freshness: { status: "not-a-feed", basis: "release-day study on daily closes" },
  describe: (args) => `MDAY ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "live-dom", limitations: [
    "US listings; close-to-close on the release day.",
    "Published CPI, jobs and FOMC days, and Brazil's IPCA days from Gloom Cloud; sessions after the list's last covered day (releasesThrough) are left out.",
    "Actual, forecast and prior for the days Gloom Cloud has them (the US headlines from its kept economic calendar, IPCA from the central bank's SGS series); --surprise keeps the days that came in hot, cool or in line with the forecast.",
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
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const [history, releases, earnings] = await Promise.all([loadMacroDayHistory({ instrument, signal: ctx.signal }, ctx.marketData), loadMacroReleases(),
      loadMacroDayEarnings({ instrument, signal: ctx.signal })]);
    ctx.signal.throwIfAborted();
    const model = projectMacroDays(history.history, { symbol: instrument.symbol, lookbackYears: Number(args.options.lookbackYears) || 5,
      releases: releases.releases, coveredThrough: releases.coveredThrough, earnings: earnings.reports });
    const notes = [staleMacroReleasesNotice(releases), macroDayEarningsNotice(earnings)].filter((note): note is string => !!note);
    const row = (label: string, stats: MacroDayStats) => ({ label, ...stats });
    // A yield index (^TNX) moves by its level: its columns are headed bp and read the change in the yield.
    const yieldMoves = model.basis === "yield";
    const bp = (signed: boolean) => (value: unknown) => typeof value === "number" ? formatMacroDayMove(value, "yield", { signed, unit: false }) : "--";
    const move = yieldMoves ? bp(true) : percent;
    const absMove = yieldMoves ? bp(false) : percent;
    const header = (label: string) => yieldMoves ? `${label} bp` : label;
    const release = String(args.options.release ?? "all");
    const surprise = String(args.options.surprise ?? "all") as MacroSurprise | "all";
    const events = model.events.filter((event) => (release === "all" || event.kind === release) && matchesSurprise(event, surprise));
    // The days the filter keeps get a row of their own: how the name moved on hot CPI days.
    const selected = surprise === "all" ? [] : [row(`${MACRO_SURPRISE_LABELS[surprise]} ${release === "all" ? "release"
      : MACRO_EVENT_LABELS[release as MacroEventKind]}`, macroDayStats(events, model.normal.meanAbs))];
    return {
      sections: [
        { title: "By release", columns: [{ key: "label", header: "Day" }, { key: "count", header: "Days" },
          { key: "meanAbs", header: header("Avg |move|"), format: absMove }, { key: "multiple", header: "vs normal", format: multiple },
          { key: "mean", header: header("Avg move"), format: move }, { key: "hitRate", header: "Up", format: share }],
        rows: [...model.kinds.map((kind) => row(MACRO_EVENT_LABELS[kind], model.byKind[kind])), ...selected,
          row(model.kinds.includes("ipca") ? "Any US release" : "Any release", model.allEvents), ...(model.earnings.count ? [row("Earnings", model.earnings)] : []), row("Normal day", model.normal)] },
        { title: "Release days", columns: [{ key: "date", header: "Date" }, { key: "event", header: "Release" },
          { key: "actual", header: "Actual" }, { key: "forecast", header: "Forecast" }, { key: "prior", header: "Prior" },
          { key: "surprise", header: "Surprise" },
          { key: "session", header: "Session" }, { key: "move", header: header("Move"), format: move }, { key: "multiple", header: "vs normal", format: multiple }],
        rows: events.map(({ figures, ...event }) => ({ ...event, event: macroDayEventLabel(event), actual: figures?.actual ?? null,
          forecast: figures?.forecast ?? null, prior: figures?.prior ?? null, surprise: figures?.surprise ?? null,
          ...(figures ? { headline: figures.event } : {}) })) },
      ],
      complete: !history.stale && !earnings.stale && !history.error && !notes.length && model.events.length > 0,
      unavailableSymbols: model.events.length ? [] : [instrument.symbol],
      errors: history.error ? [history.error] : [],
      ...(notes.length ? { notes } : {}),
      metadata: { unit: yieldMoves ? "change in the yield in percentage points, close to close on the release day"
        : "decimal return, close to close on the release day", start: model.start, asOf: model.asOf,
        releasesThrough: releases.coveredThrough, releaseSources: Object.values(MACRO_RELEASE_SOURCES),
        stale: history.stale || earnings.stale, fetchedAt: history.fetchedAt, methodology: "docs/research-data.md#macro-day-reaction" },
    };
  },
};
