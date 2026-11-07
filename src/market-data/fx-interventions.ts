import { apiClient } from "../api-client";
import type { FxInterventionDay, FxInterventionMonth, FxInterventionRun, FxInterventionsPayload } from "../api-client/fx-interventions";
import { currencyPairSpelling } from "../utils/currency-pair";
import { logFailure } from "../utils/log-failure";

/**
 * Japan's foreign exchange interventions as its Ministry of Finance publishes
 * them: each intervention, from the quarterly releases, and each monthly
 * total, which names no day and no pair until its quarter is released. Shown
 * in `fx` and `history` notes for a yen pair, and on a yen pair's chart.
 */

/** The two currencies of a yen pair, as the listing writes them: USD and JPY for USDJPY=X. */
export interface FxInterventionPair {
  base: string;
  quote: string;
}

/** The side Japan took: it bought yen to hold it up, or sold yen to hold it down. */
type FxInterventionSide = "yen bought" | "yen sold";

/** A total the ministry has reported whose days are not published yet. */
interface UndatedTotal {
  from: string;
  to: string;
  amountJpy: number;
  releasedOn: string;
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CURRENCY_WORDS: Record<string, string> = { USD: "dollars", JPY: "yen", EUR: "euros", DEM: "marks", IDR: "rupiah" };
const DAYS_KNOWN: ReadonlySet<unknown> = new Set(["all", "partial", "none"]);

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isCode = (value: unknown) => value === null || typeof value === "string" && /^[A-Z]{3}$/.test(value);
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

function readsAsDay(day: FxInterventionDay | undefined): boolean {
  return !!day && isDay(day.date) && isAmount(day.amountJpy) && isCode(day.sold) && isCode(day.bought) && typeof day.pair === "string";
}

function readsAsRun(run: FxInterventionRun | undefined): boolean {
  return !!run && isDay(run.from) && isDay(run.to) && run.to >= run.from && Number.isInteger(run.days) && run.days >= 1
    && isAmount(run.amountJpy) && isCode(run.sold) && isCode(run.bought) && typeof run.pair === "string";
}

function readsAsMonth(month: FxInterventionMonth | undefined): boolean {
  return !!month && isDay(month.from) && isDay(month.to) && month.to >= month.from && isAmount(month.amountJpy) && isDay(month.releasedOn)
    && DAYS_KNOWN.has(month.daysKnown) && isAmount(month.undatedAmountJpy) && month.undatedAmountJpy <= month.amountJpy;
}

/**
 * The reply as this app reads it, or null: a reply with a day out of order, a
 * negative or missing amount or a period that ends before it starts is no
 * record, never a guessed one. A server without the route answers 404, which
 * the loader also reads as none.
 */
export function readFxInterventions(payload: unknown): FxInterventionsPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as FxInterventionsPayload;
  if (record.status !== "available" || !Array.isArray(record.days) || !Array.isArray(record.interventions) || !Array.isArray(record.months)
    || !(record.dailyThrough === null || isDay(record.dailyThrough))) return null;
  const inOrder = <T>(entries: readonly T[], date: (entry: T) => string) => entries.every((entry, index) => index === 0 || date(entries[index - 1]!) <= date(entry));
  if (!record.days.every(readsAsDay) || !inOrder(record.days, (day) => day.date)) return null;
  if (!record.interventions.every(readsAsRun) || !inOrder(record.interventions, (run) => run.from)) return null;
  return record.months.every(readsAsMonth) ? record : null;
}

type FxInterventionsClient = Pick<typeof apiClient, "getCloudFxInterventions">;
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;

/**
 * A loader of the record from Gloom Cloud: null when it has none (not read
 * yet, an older server) or could not be reached, so a note or a chart marker
 * is left out, never the rate or the chart it goes with. One request serves
 * every caller for ten minutes, a failed one for a minute.
 */
export function createFxInterventionsLoader(
  client: FxInterventionsClient,
  now: () => number = Date.now,
): () => Promise<FxInterventionsPayload | null> {
  let held: { at: number; ttl: number; promise: Promise<FxInterventionsPayload | null> } | null = null;
  return () => {
    const at = now();
    if (held && at - held.at < held.ttl) return held.promise;
    const promise = client.getCloudFxInterventions()
      .then(readFxInterventions, logFailure("market-data.fx-interventions", "Japan's intervention record could not be read", null));
    const entry = { at, ttl: FRESH_MS, promise };
    held = entry;
    void promise.then((payload) => { if (!payload) entry.ttl = RETRY_MS; });
    return promise;
  };
}

/** The record from Gloom Cloud, shared by every caller in the app. */
export const loadFxInterventions = createFxInterventionsLoader(apiClient);

/** The pair a listing is, when one side is the yen: USD and JPY for USDJPY=X or JPY=X. */
export function fxInterventionPair(symbol: string, exchange?: string): FxInterventionPair | null {
  const spelling = currencyPairSpelling(symbol, exchange);
  if (!spelling || spelling.ambiguous) return null;
  const base = spelling.symbol.slice(0, 3), quote = spelling.symbol.slice(3, 6);
  return base === "JPY" || quote === "JPY" ? { base, quote } : null;
}

const inPair = (run: Pick<FxInterventionRun, "sold" | "bought">, pair: FxInterventionPair) => (
  run.sold === pair.base && run.bought === pair.quote || run.sold === pair.quote && run.bought === pair.base
);
/** USD/JPY either way round: the only pair a monthly total, which names none, is shown for. */
const isDollarYen = (pair: FxInterventionPair) => inPair({ sold: "USD", bought: "JPY" }, pair);

/** The pair's interventions, oldest first. */
function fxInterventionsIn(payload: FxInterventionsPayload, pair: FxInterventionPair): FxInterventionRun[] {
  return payload.interventions.filter((run) => inPair(run, pair));
}

/** Which way the ministry went. */
function fxInterventionSide(run: Pick<FxInterventionRun, "sold" | "bought">): FxInterventionSide | null {
  return run.bought === "JPY" ? "yen bought" : run.sold === "JPY" ? "yen sold" : null;
}

/**
 * Monthly totals, or the part of one, no published day accounts for yet: for
 * USD/JPY only, since a total names no pair and nearly every intervention
 * since 2004 has been in it. A month that runs past the daily record counts
 * from the day after it.
 */
function undatedTotals(payload: FxInterventionsPayload, pair: FxInterventionPair): UndatedTotal[] {
  if (!isDollarYen(pair)) return [];
  return payload.months.filter((month) => month.undatedAmountJpy > 0).map((month) => {
    const after = month.daysKnown === "partial" && payload.dailyThrough ? nextDay(payload.dailyThrough) : month.from;
    return { from: after > month.from && after <= month.to ? after : month.from, to: month.to, amountJpy: month.undatedAmountJpy, releasedOn: month.releasedOn };
  });
}

function dayText(date: string, withYear = true): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month! - 1]}${withYear ? ` ${year}` : ""}`;
}

/** 22 Sep 2022, 21–24 Oct 2022, 29 Apr–1 May 2024, 29 Dec 2003–16 Jan 2004. */
function spanText(from: string, to: string, withYear = true): string {
  if (from === to) return dayText(from, withYear);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${dayText(to, withYear)}`;
  return `${dayText(from, withYear && from.slice(0, 4) !== to.slice(0, 4))}–${dayText(to, withYear)}`;
}

/** ¥11,734.9 billion: the ministry's own unit and precision. */
function yenText(amountJpy: number): string {
  return `¥${(amountJpy / 1e9).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} billion`;
}

/** ¥11.7tn, ¥780bn: short enough for a list or a chart caption. */
function yenShort(amountJpy: number): string {
  return amountJpy >= 1e12 ? `¥${(amountJpy / 1e12).toFixed(1)}tn` : `¥${Math.round(amountJpy / 1e9).toLocaleString("en-US")}bn`;
}

/** Dollars sold for yen; the ministry's words when a side has no code. */
function directionText(run: Pick<FxInterventionRun, "sold" | "bought" | "pair">): string {
  const sold = run.sold && CURRENCY_WORDS[run.sold], bought = run.bought && CURRENCY_WORDS[run.bought];
  return sold && bought ? `${sold} sold for ${bought}` : run.pair;
}

const pairText = (pair: FxInterventionPair) => `${pair.base}/${pair.quote}`;
const runText = (run: FxInterventionRun) => (
  `${spanText(run.from, run.to)}, ${yenText(run.amountJpy)} of ${directionText(run)}${run.days > 1 ? ` on ${run.days} days` : ""}`
);
const periodText = (total: UndatedTotal) => `from ${dayText(total.from, total.from.slice(0, 4) !== total.to.slice(0, 4))} to ${dayText(total.to)}`;
const releasedText = (total: UndatedTotal) => `a monthly total released ${dayText(total.releasedOn)}: its days and pair come with the quarterly release`;
/** The last day any release covers, a monthly one included. */
function recordsThrough(payload: FxInterventionsPayload): string | null {
  return [payload.dailyThrough, ...payload.months.map((month) => month.to)].filter((date): date is string => !!date).sort().at(-1) ?? null;
}

/**
 * `fx`'s note for a yen pair: the ministry's latest intervention in it, and
 * for USD/JPY any monthly total its days have not been published for yet.
 * Nothing for a pair it never intervened in and no undated total.
 */
export function fxInterventionLatestNote(payload: FxInterventionsPayload, pair: FxInterventionPair): string | null {
  const last = fxInterventionsIn(payload, pair).at(-1);
  const undated = undatedTotals(payload, pair).at(-1);
  if (!last && !undated) return null;
  const through = recordsThrough(payload);
  const sentences = [
    ...undated ? [`Japan's Ministry of Finance reported ${yenText(undated.amountJpy)} of intervention ${periodText(undated)}, ${releasedText(undated)}.`] : [],
    ...last ? [`${undated ? "Its last dated intervention" : "Japan's Ministry of Finance last intervened"} in ${pairText(pair)}: ${runText(last)}.`] : [],
  ];
  return `${sentences.join(" ")}${through ? ` Records through ${dayText(through)}.` : ""}`;
}

/** At most this many interventions are named in a window; older ones are counted. */
const NAMED_INTERVENTIONS = 6;

/**
 * `history`'s note: the ministry's interventions in the pair between the
 * first bar shown and the end of the last one's period, newest last, in short
 * amounts, and for USD/JPY a monthly total in it whose days are not published
 * yet. Nothing when the bars span none.
 */
export function fxInterventionWindowNote(payload: FxInterventionsPayload, pair: FxInterventionPair, from: string, to: string): string | null {
  const runs = fxInterventionsIn(payload, pair).filter((run) => run.to >= from && run.from <= to);
  const undated = undatedTotals(payload, pair).filter((total) => total.to >= from && total.from <= to);
  if (runs.length === 0 && undated.length === 0) return null;
  const named = runs.slice(-NAMED_INTERVENTIONS);
  const earlier = runs.length - named.length;
  const sides = new Set(runs.map(fxInterventionSide));
  const side = sides.size === 1 ? [...sides][0] : null;
  const lead = side === "yen bought" ? "bought yen" : side === "yen sold" ? "sold yen" : "intervened";
  const entry = (run: FxInterventionRun) => {
    const own = side ? null : fxInterventionSide(run);
    return `${spanText(run.from, run.to)} ${yenShort(run.amountJpy)}${own ? ` ${own}` : ""}`;
  };
  const sentences = [
    ...named.length > 0 ? [`Japan's Ministry of Finance ${lead} in ${pairText(pair)} in these bars: ${named.map(entry).join("; ")}${
      earlier > 0 ? `; and ${earlier} earlier from ${dayText(runs[0]!.from)}` : ""}.`] : [],
    ...undated.map((total) => `${named.length > 0 ? "It also" : "Japan's Ministry of Finance"} reported ${yenShort(total.amountJpy)} ${periodText(total)}, ${releasedText(total)}.`),
  ];
  return sentences.join(" ");
}

/** A chart marker for one intervention, or for a total its days are not published for yet. */
export interface FxInterventionMarker {
  id: string;
  date: string;
  /** A total's last day: it is drawn from its first day to here. */
  endDate?: string;
  /** Its caption, longest first: the `MoF` prefix goes first when room is short, never the dates. */
  captions: string[];
  /** A total with no day yet: drawn dotted across its period. */
  undated: boolean;
  amountJpy: number;
  side: FxInterventionSide | null;
}

const PAIR_NOT_PUBLISHED = "pair not yet published";

/** The pair's interventions, then for USD/JPY any total without days, as chart markers. */
export function fxInterventionMarkers(payload: FxInterventionsPayload, pair: FxInterventionPair): FxInterventionMarker[] {
  return [
    ...fxInterventionsIn(payload, pair).map((run): FxInterventionMarker => {
      const amount = yenShort(run.amountJpy), side = fxInterventionSide(run);
      const told = side ? `${amount} ${side}` : amount;
      return {
        id: `mof:${run.from}:${run.sold}:${run.bought}`, date: run.from, captions: [...new Set([`MoF ${told}`, told, amount])],
        undated: false, amountJpy: run.amountJpy, side,
      };
    }),
    ...undatedTotals(payload, pair).map((total): FxInterventionMarker => {
      const dated = `${yenShort(total.amountJpy)} ${spanText(total.from, total.to, false)}`;
      return {
        id: `mof:${total.from}:${total.to}`, date: total.from, endDate: total.to,
        captions: [`MoF ${dated}, ${PAIR_NOT_PUBLISHED}`, `${dated}, ${PAIR_NOT_PUBLISHED}`, dated],
        undated: true, amountJpy: total.amountJpy, side: null,
      };
    }),
  ];
}

/** One caption for markers too close to caption apart: their sum and count, and the side when they share one. */
export function fxInterventionSharedCaptions(markers: readonly FxInterventionMarker[]): string[] {
  const total = `${yenShort(markers.reduce((sum, marker) => sum + marker.amountJpy, 0))} ×${markers.length}`;
  const sides = new Set(markers.map((marker) => marker.side));
  const side = sides.size === 1 ? [...sides][0] : null;
  return side ? [`MoF ${total} ${side}`, `${total} ${side}`, total] : [`MoF ${total}`, total];
}
