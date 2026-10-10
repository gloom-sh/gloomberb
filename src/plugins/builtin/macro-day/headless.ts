import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadMacroDayHistory, loadMacroReleases } from "./client";
import { projectMacroDays, type MacroDayStats } from "./model";
import { MACRO_EVENT_KINDS, MACRO_EVENT_LABELS, MACRO_RELEASE_SOURCES, staleMacroReleasesNotice } from "./releases";

// A mean that rounds to zero reads 0.00%, never -0.00%.
const percent = (value: unknown) => typeof value !== "number" ? "--" : /[1-9]/.test((value * 100).toFixed(2)) ? `${(value * 100).toFixed(2)}%` : "0.00%";
const multiple = (value: unknown) => typeof value === "number" ? `${value.toFixed(2)}x` : "--";
const share = (value: unknown) => typeof value === "number" ? `${Math.round(value * 100)}%` : "--";

export const macroDayHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  // Dated by the release list (releasesThrough) as much as by the closes, so no session schedule applies.
  freshness: { status: "not-a-feed", basis: "release-day study on daily closes" },
  describe: (args) => `MDAY ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "live-dom", limitations: [
    "US listings; close-to-close on the release day.",
    "Published CPI, jobs and FOMC days; sessions after the list's last covered day (releasesThrough) are left out.",
  ] },
  options: [
    { key: "release", type: "enum", values: [{ value: "all" }, ...MACRO_EVENT_KINDS.map((value) => ({ value }))], defaultValue: "all",
      description: "Release the pane lists", pluginState: { pluginId: "ticker-research", key: "release" } },
    { key: "lookbackYears", type: "integer", minimum: 1, maximum: 5, defaultValue: 5, description: "Years of daily closes" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const [history, releases] = await Promise.all([loadMacroDayHistory({ instrument, signal: ctx.signal }, ctx.marketData), loadMacroReleases()]);
    ctx.signal.throwIfAborted();
    const model = projectMacroDays(history.history, { symbol: instrument.symbol, lookbackYears: Number(args.options.lookbackYears) || 5,
      releases: releases.releases, coveredThrough: releases.coveredThrough });
    const releasesNotice = staleMacroReleasesNotice(releases);
    const row = (label: string, stats: MacroDayStats) => ({ label, ...stats });
    const release = String(args.options.release ?? "all");
    const events = release === "all" ? model.events : model.events.filter((event) => event.kind === release);
    return {
      sections: [
        { title: "By release", columns: [{ key: "label", header: "Day" }, { key: "count", header: "Days" },
          { key: "meanAbs", header: "Avg |move|", format: percent }, { key: "multiple", header: "vs normal", format: multiple },
          { key: "mean", header: "Avg move", format: percent }, { key: "hitRate", header: "Up", format: share }],
        rows: [...MACRO_EVENT_KINDS.map((kind) => row(MACRO_EVENT_LABELS[kind], model.byKind[kind])),
          row("Any release", model.allEvents), row("Normal day", model.normal)] },
        { title: "Release days", columns: [{ key: "date", header: "Date" }, { key: "event", header: "Release" },
          { key: "session", header: "Session" }, { key: "move", header: "Move", format: percent }, { key: "multiple", header: "vs normal", format: multiple }],
        rows: events.map((event) => ({ ...event, event: MACRO_EVENT_LABELS[event.kind] })) },
      ],
      complete: !history.stale && !history.error && !releasesNotice && model.events.length > 0,
      unavailableSymbols: model.events.length ? [] : [instrument.symbol],
      errors: history.error ? [history.error] : [],
      ...(releasesNotice ? { notes: [releasesNotice] } : {}),
      metadata: { unit: "decimal return, close to close on the release day", start: model.start, asOf: model.asOf,
        releasesThrough: releases.coveredThrough, releaseSources: Object.values(MACRO_RELEASE_SOURCES),
        stale: history.stale, fetchedAt: history.fetchedAt, methodology: "docs/research-data.md#macro-day-reaction" },
    };
  },
};
