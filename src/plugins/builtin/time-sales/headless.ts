import { MISSING_VALUE } from "../../../utils/format";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import { listedAbroad, subMinuteDataMessage } from "../../../cli/known-gaps";
import type { TapeRange, TapeSnapshot } from "../../../api-client/tape";
import { fetchTape } from "./client";
import { newestFirst, quoteSpread, tapePrice, tapePriceDigits, tapeStatistics, tapeTimeKey } from "./model";
import { REPORT_ROWS } from "../shared/headless-options";
import {
  exactTapeMoment, inTapeRange, lastSessionNote, normalizeTapeClock, parseTapeClock, servedWindow, sessionDay, tapeMoment, tapePageEnd, tapeWindowRange,
} from "./window";

type Format = NonNullable<HeadlessPaneColumn["format"]>;
const fixedPrice = (digits: number): Format => (value) => tapePrice(typeof value === "number" ? value : null, digits);
const whole: Format = (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(0) : MISSING_VALUE;
const bps: Format = (value) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : MISSING_VALUE;

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

/** What each low and high of the report is taken over; the session's is the rule quote and GIP read the day's range by. */
function tapeRangeBasis(window: string): string {
  return `${window} low and high: every print listed, odd lots included. Regular session low and high: consolidated prints that set a price, `
    + "as quote and GIP read them; odd lots and special-condition prints set none.";
}

/**
 * The window `--from`/`--to` ask for, read against the session the latest tape
 * serves, then fetched as that window. A server that predates windows answers
 * with its latest tape: its prints that fall in the window stand, and a note
 * says from when that tape runs.
 */
async function loadWindow(symbol: string, exchange: string, from: string, to: string, ctx: HeadlessPaneContext, quotesView: boolean) {
  const latest = await fetchTape(symbol, exchange, ctx.signal, ctx.apiClient);
  const served = servedWindow(latest);
  if (!served) throw new Error(`TAS has no session for ${symbol} to read a window of; run it without --from and --to for the latest prints.`);
  const range = tapeWindowRange(served, from ? parseTapeClock(from) : null, to ? parseTapeClock(to) : null, symbol);
  const data = await fetchTape(symbol, exchange, ctx.signal, ctx.apiClient, range);
  // A bound inside a second (a page read on from a print) is named to its nanosecond.
  const bound = (stamp: string) => tapeTimeKey(stamp).slice(19, 29) === ".000000000" ? tapeMoment(Date.parse(stamp)) : exactTapeMoment(stamp);
  const notes = [`Window: ${sessionDay(served.date)}, ${bound(range.from)} to ${bound(range.to)}.`];
  if (data.window) {
    // Only the window's own prints: a server reading from the second around the start sends earlier ones too, and says so.
    const { window, capacity } = data;
    // A server from before exact windows reads from the start of the second: its page holds that second's first prints.
    const floored = tapeTimeKey(window.from) < tapeTimeKey(range.from);
    if (floored) notes.push(`This server read the window from ${exactTapeMoment(window.from)}, before its start: its earlier prints are left out.`);
    const command = (kind: "trades" | "quotes", from: string) => `fn ${kind === "quotes" ? "QR" : "TAS"} ${symbol} --from ${from}${to ? ` --to ${to}` : ""}`;
    const pageNotes: Record<"trades" | "quotes", string | null> = { trades: null, quotes: null };
    // The list's rows on this page, and the note on where the next page starts.
    const paged = <T extends { timestamp: string }>(kind: "trades" | "quotes", list: T[]): T[] => {
      if (!window.truncated[kind]) return list;
      // A full page ends before the stamp its last prints share, and names the exact stamp the next page reads from:
      // the trades' in TAS, which pages by them, the quotes' in QR.
      const page = tapePageEnd(list);
      const last = page.rows.at(-1)?.timestamp;
      const head = `The window holds more than ${capacity[kind]} ${kind}: these are the first ${page.rows.length}${last ? `, through ${exactTapeMoment(last)}` : ""}.`;
      // A second-start page that ends at its first prints in the window, or before them, reaches no further on: the
      // rest of that second is out of its reach, and the next read starts on the next second.
      if (floored && page.rows.length === list.length) {
        const nextSecond = new Date(Date.parse(`${tapeTimeKey(last ?? range.from).slice(0, 19)}Z`) + 1000).toISOString().replace(".000Z", "Z");
        const readOn = tapeTimeKey(nextSecond) < tapeTimeKey(range.to) ? ` Read on from that second: ${command(kind, nextSecond)}` : "";
        const unread = `cannot be read from it, as it reads a window from the start of its second.${readOn}`;
        pageNotes[kind] = last
          ? `${head} Any ${kind} after these and before ${tapeMoment(Date.parse(nextSecond))} ${unread}`
          : `This server's page of ${capacity[kind]} ${kind} ends before the window's start: any from ${exactTapeMoment(range.from)} `
            + `and before ${tapeMoment(Date.parse(nextSecond))} ${unread}`;
      } else if (page.next) {
        pageNotes[kind] = `${head} Read on from the next: ${command(kind, page.next)}`;
      }
      return page.rows;
    };
    const trades = paged("trades", data.trades.filter((row) => inTapeRange(row.timestamp, range)));
    const quotes = paged("quotes", data.quotes.filter((row) => inTapeRange(row.timestamp, range)));
    // QR pages by its quotes, TAS by its trades: the view's own list first.
    const order = quotesView ? [pageNotes.quotes, pageNotes.trades] : [pageNotes.trades, pageNotes.quotes];
    notes.push(...order.filter((note): note is string => note !== null));
    const times = oldestFirst([...trades, ...quotes]).map((row) => row.timestamp);
    return { data: { ...data, trades, quotes, asOf: times.at(-1) ?? data.asOf, observedFrom: times[0] ?? data.observedFrom }, range, notes };
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
    { key: "tab", type: "enum", settingKey: "tab", values: [{ value: "trades", label: "Trades" }, { value: "quotes", label: "NBBO" }], description: "Which tape to show first." },
    { key: "limit", shot: REPORT_ROWS, type: "integer", minimum: 1, maximum: 1000, defaultValue: 100, description: "Maximum recent prints in the report." },
    { key: "from", shot: WINDOW_OPTION, type: "string", defaultValue: "", placeholder: "time", example: "--from 10:30 --to 10:35",
      description: "Start of a window of the served session (the latest): 10:30 or 10:30:15 on New York's clock, 14:30Z on UTC's, or a timestamp such as 2026-11-20T14:30:00Z (New York time without Z or an offset), to the nanosecond a print's own stamp gives."
        + " The report then lists that window's prints oldest first; without --to it runs to the end of what is served.",
      normalize: normalizeTapeClock },
    { key: "to", shot: WINDOW_OPTION, type: "string", defaultValue: "", placeholder: "time",
      description: "End of the window, as --from takes it; without --from the window starts at 04:00 New York time.",
      normalize: normalizeTapeClock },
  ],
  discovery: { aliases: ["TAS", "QR"], dataRequirements: ["Gloom Cloud consolidated US trades and quotes"],
    limitations: ["Bounded observed window, not a complete session.", "Trades and quotes are delayed fifteen minutes without realtime entitlement.", "Quote sizes are round lots.", "No Level 2 or inferred aggressor side."] },
  // QR is the NBBO view of the same tape: its report leads with the quotes, named as such.
  describe: (args, result) => `${result?.metadata?.view === "quotes" ? "Quote recap" : "Time and sales"} ${args.argument ?? ""}`,
  async load(args, ctx) {
    const symbol = args.symbols[0] ?? (typeof args.argument === "string" ? args.argument : "");
    const instrument = await ctx.resolveInstrument?.(symbol);
    const quotesView = (args.options.tab ?? ctx.settings?.tab) === "quotes";
    if (listedAbroad(symbol, instrument?.exchange)) {
      // Say why the table is empty and where the finest bars for it are, rather than the tape's bare "unavailable".
      return { complete: false, sections: [
        { title: quotesView ? "NBBO" : "Trades", rows: [], empty: subMinuteDataMessage(symbol, "abroad") },
      ], ...(quotesView ? { metadata: { view: "quotes" } } : {}) };
    }
    const exchange = instrument?.exchange ?? "";
    const from = String(args.options.from ?? "").trim(), to = String(args.options.to ?? "").trim();
    const windowed = from || to ? await loadWindow(symbol, exchange, from, to, ctx, quotesView) : null;
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
    const lastSession = lastSessionNote(data);
    if (!windowed && lastSession) notes.unshift(lastSession);
    if (!windowed && trades.length < data.trades.length) notes.push(`Listing the first ${trades.length} of ${data.trades.length} observed trades, newest first; --limit takes up to 1000.`);
    // SIP prints, real-time or fifteen minutes delayed by entitlement, dated by the newest print.
    const freshness = data.feed === "sip"
      ? { status: "live" as const, cadence: "daily" as const }
      : { status: "delayed" as const, delayMinutes: Math.round(data.delaySeconds / 60), cadence: "daily" as const };
    const nbbo = { title: "NBBO", columns: formattedColumns(quotes, { bps }), rows: quotes };
    const tape = [
      // The last price's rank among the window's prints, whole, as the pane shows it.
      { title: windowed ? "Window" : "Observed window", columns: formattedColumns(window, { vwap: price, low: price, high: price, pricePercentile: whole }), rows: window },
      { title: "Regular session", columns: formattedColumns([data.session], { high: price, low: price }), rows: [data.session] },
      { title: "Trades", columns: formattedColumns(trades, { price }), rows: trades },
    ];
    // Each low says what it is the low of: the window's every print, the session's as quote and GIP read it.
    const lows = [...notes, tapeRangeBasis(tape[0]!.title)];
    return { freshness, notes: lows, sections: quotesView ? [nbbo, ...tape] : [...tape, nbbo], errors: data.gaps, metadata: { source: data.source, access: data.access, delaySeconds: data.delaySeconds,
      asOf: data.asOf, observedFrom: data.observedFrom, generatedAt: data.generatedAt, status: data.status, ...(windowed ? { window: windowed.range } : {}),
      complete: data.status === "available", capacity: data.capacity, dropped: data.dropped, corrections: data.corrections, cancels: data.cancels, connected: data.connected,
      ...(quotesView ? { view: "quotes" } : {}) } };
  },
};

/** QR: the same tape, its NBBO first, named as such where it answers a listing abroad too. */
export const quoteRecapHeadless: HeadlessPaneDefinition<"bundle"> = { ...timeSalesHeadless, usListingsOnly: "Quote recap" };
