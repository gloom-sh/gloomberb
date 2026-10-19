import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import { listedAbroad, subMinuteDataMessage } from "../../../cli/known-gaps";
import type { TapeRange, TapeSnapshot } from "../../../api-client/tape";
import { fetchTape } from "./client";
import { newestFirst, quoteSpread, tapePrice, tapePriceDigits, tapeStatistics, tapeTimeKey } from "./model";
import { REPORT_ROWS } from "../shared/headless-options";
import { inTapeRange, normalizeTapeClock, parseTapeClock, servedWindow, sessionDay, tapeMoment, tapeWindowRange } from "./window";

type Format = NonNullable<HeadlessPaneColumn["format"]>;
const fixedPrice = (digits: number): Format => (value) => tapePrice(typeof value === "number" ? value : null, digits);
const whole: Format = (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(0) : "--";
const bps: Format = (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "--";

/** Every row key in order, with the pane's rounding where the report would otherwise print raw floats. */
function formattedColumns(rows: readonly HeadlessPaneRow[], formats: Record<string, Format>): HeadlessPaneColumn[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))]
    .map((key) => ({ key, header: key, ...(formats[key] ? { format: formats[key] } : {}) }));
}

function oldestFirst<T extends { timestamp: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => tapeTimeKey(a.timestamp).localeCompare(tapeTimeKey(b.timestamp)));
}

/** When `--limit` cuts a window's trades: how many of them are listed. */
function listedNote(range: TapeRange, served: number, listed: number): string[] {
  return listed < served ? [`Listing the first ${listed} of the ${served} trades from ${tapeMoment(Date.parse(range.from))}; --limit takes up to 1000.`] : [];
}


const WINDOW_OPTION = { reportOnly: "lists a window of the session in the text report" };

/**
 * The window `--from`/`--to` ask for, read against the session the latest tape
 * serves, then fetched as that window. A server that predates windows answers
 * with its latest tape: its prints that fall in the window stand, and a note
 * says from when that tape runs.
 */
async function loadWindow(symbol: string, exchange: string, from: string, to: string, ctx: HeadlessPaneContext) {
  const latest = await fetchTape(symbol, exchange, ctx.signal, ctx.apiClient);
  const served = servedWindow(latest);
  if (!served) throw new Error(`TAS has no session for ${symbol} to read a window of; run it without --from and --to for the latest prints.`);
  const range = tapeWindowRange(served, from ? parseTapeClock(from) : null, to ? parseTapeClock(to) : null);
  const data = await fetchTape(symbol, exchange, ctx.signal, ctx.apiClient, range);
  const notes = [`Window: ${sessionDay(served.date)}, ${tapeMoment(Date.parse(range.from))} to ${tapeMoment(Date.parse(range.to))}.`];
  if (data.window) {
    if (data.window.truncated.trades) {
      const last = data.trades.at(-1)?.timestamp;
      notes.push(`The window holds more than ${data.capacity.trades} trades: these are the first${last ? `, through ${tapeMoment(Date.parse(last))}` : ""}; start --from there to read on.`);
    }
    return { data, range, notes };
  }
  const trades = data.trades.filter((row) => inTapeRange(row.timestamp, range)), quotes = data.quotes.filter((row) => inTapeRange(row.timestamp, range));
  // Dated by what it lists, as a served window is.
  const times = oldestFirst([...trades, ...quotes]).map((row) => row.timestamp);
  const kept = { ...data, trades, quotes, asOf: times.at(-1) ?? null, observedFrom: times[0] ?? null };
  if (data.observedFrom && tapeTimeKey(data.observedFrom) > tapeTimeKey(range.from)) {
    notes.push(`This server serves only its latest tape, from ${tapeMoment(Date.parse(data.observedFrom))}: prints before it are not listed.`);
  }
  return { data: kept, range, notes };
}

export const timeSalesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", placeholder: "ticker", description: "US equity ticker." },
  usListingsOnly: "Time and sales",
  usListingsOnlyHint: (symbol) => subMinuteDataMessage(symbol, "abroad"),
  options: [
    { key: "limit", shot: REPORT_ROWS, type: "integer", minimum: 1, maximum: 1000, defaultValue: 100, description: "Maximum recent prints in the report." },
    { key: "from", shot: WINDOW_OPTION, type: "string", defaultValue: "", placeholder: "time", example: "--from 10:30 --to 10:35",
      description: "Start of a window of the served session, as a time of day: 10:30 or 10:30:15 on New York's clock, 14:30Z on UTC's."
        + " The report then lists that window's prints oldest first; without --to it runs to the end of what is served.",
      normalize: normalizeTapeClock },
    { key: "to", shot: WINDOW_OPTION, type: "string", defaultValue: "", placeholder: "time",
      description: "End of the window, as --from takes it; without --from the window starts at 04:00 New York time.",
      normalize: normalizeTapeClock },
  ],
  discovery: { aliases: ["TAS", "QR"], dataRequirements: ["Gloom Cloud SIP trade and quote feed"],
    limitations: ["Bounded observed window, not a complete session.", "SIP is delayed fifteen minutes without realtime entitlement.", "Quote sizes are round lots.", "No Level 2 or inferred aggressor side."] },
  describe: (args) => `Time and sales ${args.argument ?? ""}`,
  async load(args, ctx) {
    const symbol = args.symbols[0] ?? (typeof args.argument === "string" ? args.argument : "");
    const instrument = await ctx.resolveInstrument?.(symbol);
    if (listedAbroad(symbol, instrument?.exchange)) {
      // Say why the table is empty and where the finest bars for it are, rather than the tape's bare "unavailable".
      return { complete: false, sections: [
        { title: ctx.settings?.tab === "quotes" ? "NBBO" : "Trades", rows: [], empty: subMinuteDataMessage(symbol, "abroad") },
      ] };
    }
    const exchange = instrument?.exchange ?? "";
    const from = String(args.options.from ?? "").trim(), to = String(args.options.to ?? "").trim();
    const windowed = from || to ? await loadWindow(symbol, exchange, from, to, ctx) : null;
    const data: TapeSnapshot = windowed?.data ?? await fetchTape(symbol, exchange, ctx.signal, ctx.apiClient);
    const limit = Number(args.options.limit ?? 100);
    const statistics = tapeStatistics(data);
    const window = [{ from: statistics.from, asOf: statistics.asOf, prints: statistics.count, shares: statistics.volume,
      vwap: statistics.vwap, low: statistics.low, high: statistics.high, pricePercentile: statistics.pricePercentile }];
    // A window reads forward from its start; the latest tape newest first, as the pane lists it.
    const ordered = <T extends { timestamp: string }>(rows: readonly T[]) => windowed ? oldestFirst(rows) : newestFirst(rows);
    const quotes = ordered(data.quotes).slice(0, limit).map((row) => ({ ...row, ...quoteSpread(row), conditions: row.conditions.join(" ") }));
    // One decimal count per column, as the pane shows it, so sub-penny prints align.
    const price = fixedPrice(tapePriceDigits(data.trades.map((row) => row.price)));
    const trades = ordered(data.trades).slice(0, limit).map((row) => ({ ...row, conditions: row.conditions.join(" ") }));
    const notes = windowed ? [...windowed.notes, ...listedNote(windowed.range, data.trades.length, trades.length)] : [];
    // SIP prints, real-time or fifteen minutes delayed by entitlement, dated by the newest print.
    const freshness = data.feed === "sip"
      ? { status: "live" as const, cadence: "daily" as const }
      : { status: "delayed" as const, delayMinutes: Math.round(data.delaySeconds / 60), cadence: "daily" as const };
    return { freshness, ...(notes.length ? { notes } : {}), sections: [
      // The last price's rank among the window's prints, whole, as the pane shows it.
      { title: windowed ? "Window" : "Observed window", columns: formattedColumns(window, { vwap: price, low: price, high: price, pricePercentile: whole }), rows: window },
      { title: "Regular session", columns: formattedColumns([data.session], { high: price, low: price }), rows: [data.session] },
      { title: "Trades", columns: formattedColumns(trades, { price }), rows: trades },
      { title: "NBBO", columns: formattedColumns(quotes, { bps }), rows: quotes },
    ], errors: data.gaps, metadata: { source: data.source, feed: data.feed, delaySeconds: data.delaySeconds,
      asOf: data.asOf, observedFrom: data.observedFrom, generatedAt: data.generatedAt, status: data.status, ...(windowed ? { window: windowed.range } : {}),
      complete: data.status === "available", capacity: data.capacity, dropped: data.dropped, corrections: data.corrections, cancels: data.cancels, connected: data.connected } };
  },
};
