import { apiClient } from "../api-client";
import type { FxInterventionDay, FxInterventionPeriod, FxInterventionsPayload } from "../api-client/fx-interventions";
import { currencyPairSpelling } from "../utils/currency-pair";
import { logFailure } from "../utils/log-failure";

/**
 * Japan's foreign exchange interventions as its Ministry of Finance publishes
 * them: each day it intervened, from the quarterly releases, and each monthly
 * total, which names no day and no pair until its quarter is released. Shown
 * in `fx` and `history` notes for a yen pair, and on a yen pair's chart.
 */

/** The two currencies of a yen pair, as the listing writes them: USD and JPY for USDJPY=X. */
export interface FxInterventionPair {
  base: string;
  quote: string;
}

/** Operations in one pair and direction, each within a few days of the last: one move, as the market saw it. */
export interface FxInterventionEpisode {
  from: string;
  to: string;
  /** Days with an operation. */
  days: number;
  amountJpy: number;
  sold: string | null;
  bought: string | null;
  /** The ministry's words for the pair, for a currency the server names no code for. */
  pair: string;
}

/** Consecutive operations at most this many calendar days apart are one episode: a weekend, or one with a holiday. */
const EPISODE_GAP_DAYS = 4;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CURRENCY_WORDS: Record<string, string> = { USD: "dollars", JPY: "yen", EUR: "euros", DEM: "marks", IDR: "rupiah" };

const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isCode = (value: unknown) => value === null || typeof value === "string" && /^[A-Z]{3}$/.test(value);
const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

/**
 * The reply as this app reads it, or null: a reply with a day out of order, a
 * negative or missing amount or a period that ends before it starts is no
 * record, never a guessed one. A server without the route answers 404, which
 * the loader also reads as none.
 */
export function readFxInterventions(payload: unknown): FxInterventionsPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as FxInterventionsPayload;
  if (record.status !== "available" || !Array.isArray(record.days) || !Array.isArray(record.months)
    || !(record.dailyThrough === null || isDay(record.dailyThrough))) return null;
  let previous = "";
  for (const day of record.days) {
    if (!day || !isDay(day.date) || day.date < previous || !isAmount(day.amountJpy) || !isCode(day.sold) || !isCode(day.bought)
      || typeof day.pair !== "string") return null;
    previous = day.date;
  }
  if (record.months.some((month) => !month || !isDay(month.from) || !isDay(month.to) || month.to < month.from || !isAmount(month.amountJpy))) return null;
  return record;
}

type FxInterventionsClient = Pick<typeof apiClient, "getCloudFxInterventions">;
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
let held: { at: number; ttl: number; promise: Promise<FxInterventionsPayload | null> } | null = null;

/**
 * The record from Gloom Cloud, or null when it has none (not read yet, an older
 * server) or could not be reached: a note or a chart marker is left out, never
 * the rate or the chart it goes with. One request serves every caller for ten
 * minutes, a failed one for a minute.
 */
export function loadFxInterventions(client: FxInterventionsClient = apiClient, signal?: AbortSignal): Promise<FxInterventionsPayload | null> {
  const shared = client === apiClient;
  const now = Date.now();
  if (shared && held && now - held.at < held.ttl) return held.promise;
  const promise = client.getCloudFxInterventions(signal)
    .then(readFxInterventions, logFailure("market-data.fx-interventions", "Japan's intervention record could not be read", null));
  if (shared) {
    const entry = { at: now, ttl: FRESH_MS, promise };
    held = entry;
    void promise.then((payload) => { if (!payload && held === entry) entry.ttl = RETRY_MS; });
  }
  return promise;
}

/** The pair a listing is, when one side is the yen: USD and JPY for USDJPY=X or JPY=X. */
export function fxInterventionPair(symbol: string, exchange?: string): FxInterventionPair | null {
  const spelling = currencyPairSpelling(symbol, exchange);
  if (!spelling || spelling.ambiguous) return null;
  const base = spelling.symbol.slice(0, 3), quote = spelling.symbol.slice(3, 6);
  return base === "JPY" || quote === "JPY" ? { base, quote } : null;
}

const inPair = (day: FxInterventionDay, pair: FxInterventionPair) => (
  day.sold === pair.base && day.bought === pair.quote || day.sold === pair.quote && day.bought === pair.base
);

/** The pair's operations as episodes, oldest first. */
export function fxInterventionEpisodes(days: readonly FxInterventionDay[], pair: FxInterventionPair): FxInterventionEpisode[] {
  const episodes: FxInterventionEpisode[] = [];
  for (const day of days) {
    if (!inPair(day, pair)) continue;
    const last = episodes.at(-1);
    if (last && last.sold === day.sold && last.bought === day.bought && dayMs(day.date) - dayMs(last.to) <= EPISODE_GAP_DAYS * DAY_MS) {
      if (day.date !== last.to) last.days += 1;
      last.to = day.date;
      last.amountJpy += day.amountJpy;
    } else {
      episodes.push({ from: day.date, to: day.date, days: 1, amountJpy: day.amountJpy, sold: day.sold, bought: day.bought, pair: day.pair });
    }
  }
  return episodes;
}

/**
 * Monthly totals the daily record does not reach yet: intervention the
 * ministry has reported, whose days and pair come with its quarterly release.
 */
function undatedFxInterventions(payload: FxInterventionsPayload): FxInterventionPeriod[] {
  return payload.months.filter((month) => month.amountJpy > 0
    && (payload.dailyThrough == null || month.to > payload.dailyThrough)
    && !payload.days.some((day) => day.date >= month.from && day.date <= month.to));
}

function dayText(date: string, withYear = true): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month! - 1]}${withYear ? ` ${year}` : ""}`;
}

/** 22 Sep 2022, 21–24 Oct 2022, 29 Apr–1 May 2024, 29 Dec 2003–16 Jan 2004. */
function spanText(from: string, to: string): string {
  if (from === to) return dayText(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${dayText(to)}`;
  return `${dayText(from, from.slice(0, 4) !== to.slice(0, 4))}–${dayText(to)}`;
}

/** ¥11,734.9 billion: the ministry's own unit and precision. */
function yenText(amountJpy: number): string {
  return `¥${(amountJpy / 1e9).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} billion`;
}

/** ¥11.7tn, ¥780bn: short enough to caption a chart. */
function yenShort(amountJpy: number): string {
  return amountJpy >= 1e12 ? `¥${(amountJpy / 1e12).toFixed(1)}tn` : `¥${Math.round(amountJpy / 1e9).toLocaleString("en-US")}bn`;
}

/** Dollars sold for yen; the ministry's words when a side has no code. */
function directionText(episode: Pick<FxInterventionEpisode, "sold" | "bought" | "pair">): string {
  const sold = episode.sold && CURRENCY_WORDS[episode.sold], bought = episode.bought && CURRENCY_WORDS[episode.bought];
  return sold && bought ? `${sold} sold for ${bought}` : episode.pair;
}

const pairText = (pair: FxInterventionPair) => `${pair.base}/${pair.quote}`;
const episodeText = (episode: FxInterventionEpisode) => (
  `${spanText(episode.from, episode.to)}, ${yenText(episode.amountJpy)} of ${directionText(episode)}${episode.days > 1 ? ` on ${episode.days} days` : ""}`
);
const undatedText = (period: FxInterventionPeriod) => (
  `${yenText(period.amountJpy)} of intervention from ${dayText(period.from, period.from.slice(0, 4) !== period.to.slice(0, 4))} to ${dayText(period.to)}`
);
/** The last day any release covers, a monthly one included. */
function recordsThrough(payload: FxInterventionsPayload): string | null {
  return [payload.dailyThrough, ...payload.months.map((month) => month.to)].filter((date): date is string => !!date).sort().at(-1) ?? null;
}

/**
 * `fx`'s note for a yen pair: the ministry's latest intervention in it, and
 * any monthly total its days have not been published for yet. Nothing for a
 * pair it never intervened in and no undated total.
 */
export function fxInterventionLatestNote(payload: FxInterventionsPayload, pair: FxInterventionPair): string | null {
  const last = fxInterventionEpisodes(payload.days, pair).at(-1);
  const undated = undatedFxInterventions(payload).at(-1);
  if (!last && !undated) return null;
  const through = recordsThrough(payload);
  const sentences = [
    ...undated ? [`Japan's Ministry of Finance reported ${undatedText(undated)}, a monthly total: its days and pair come with the quarterly release.`] : [],
    ...last ? [`${undated ? "Its last dated intervention" : "Japan's Ministry of Finance last intervened"} in ${pairText(pair)}: ${episodeText(last)}.`] : [],
  ];
  return `${sentences.join(" ")}${through ? ` Records through ${dayText(through)}.` : ""}`;
}

/** At most this many episodes are named in a window; older ones are counted. */
const NAMED_EPISODES = 6;

/**
 * `history`'s note: the ministry's interventions in the pair between the first
 * and last bar shown, newest last, and a monthly total in it whose days are not
 * published yet. Nothing when the bars span none.
 */
export function fxInterventionWindowNote(payload: FxInterventionsPayload, pair: FxInterventionPair, from: string, to: string): string | null {
  const episodes = fxInterventionEpisodes(payload.days, pair).filter((episode) => episode.to >= from && episode.from <= to);
  const undated = undatedFxInterventions(payload).filter((period) => period.to >= from && period.from <= to);
  if (episodes.length === 0 && undated.length === 0) return null;
  const named = episodes.slice(-NAMED_EPISODES);
  const earlier = episodes.length - named.length;
  const sentences = [
    ...named.length > 0 ? [`Japan's Ministry of Finance intervened in ${pairText(pair)} in these bars: ${named.map(episodeText).join("; ")}${
      earlier > 0 ? `; and ${earlier} earlier from ${dayText(episodes[0]!.from)}` : ""}.`] : [],
    ...undated.map((period) => `${named.length > 0 ? "It also" : "Japan's Ministry of Finance"} reported ${undatedText(period)}, a monthly total: its days and pair come with the quarterly release.`),
  ];
  return sentences.join(" ");
}

/** A chart marker for one episode or undated total, on the day it starts. */
export interface FxInterventionMarker {
  id: string;
  date: string;
  label: string;
  /** A total with no day yet: drawn dotted at its period's first day, its label naming the period. */
  undated: boolean;
}

/** The pair's episodes, then any undated monthly total, as chart markers. */
export function fxInterventionMarkers(payload: FxInterventionsPayload, pair: FxInterventionPair): FxInterventionMarker[] {
  return [
    ...fxInterventionEpisodes(payload.days, pair).map((episode) => ({
      id: `mof:${episode.from}:${episode.sold}:${episode.bought}`, date: episode.from, label: `MoF ${yenShort(episode.amountJpy)}`, undated: false,
    })),
    ...undatedFxInterventions(payload).map((period) => ({
      id: `mof:${period.from}:${period.to}`, date: period.from,
      label: `MoF ${yenShort(period.amountJpy)} ${spanText(period.from, period.to).replace(/ \d{4}$/, "")}`, undated: true,
    })),
  ];
}
