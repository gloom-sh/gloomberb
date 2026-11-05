import { apiClient } from "../../../api-client";
import { isAccessDenied } from "../../../api-client/errors";
import type { CloudMarketResponse, CloudPricePointPayload } from "../../../api-client/types";
import { createPluginCache } from "../../../data/plugin-cache";
import { formatNumber } from "../../../utils/format";
import { loadCloudResource } from "../shared/cloud-resource";
import type { DatedReturn } from "../../../portfolio/return-metrics";
import { regressReturns } from "./risk-math";
import { accountFxPair, riskConversion } from "./risk-fx";
import { riskInstrumentId, RISK_FACTOR_INSTRUMENTS, type RiskInstrument, type RiskMarketSnapshot } from "./risk-client";

/**
 * A market episode the Stress view replays on today's holdings: from the last
 * close before the shock to the S&P 500's lowest close of the move.
 */
export interface RiskEpisode {
  id: string;
  label: string;
  /** The close the replay starts from. */
  start: string;
  /** The close it ends at: SPY's lowest of the move. */
  end: string;
}

export const RISK_EPISODES: readonly RiskEpisode[] = [
  // The record close before the selloff to the low of the crash.
  { id: "covid-2020", label: "Covid crash 2020", start: "2020-02-19", end: "2020-03-23" },
  // The record close of 3 Jan 2022 to the low of the bear market the Fed's hikes brought.
  { id: "rates-2022", label: "Rate shock 2022", start: "2022-01-03", end: "2022-10-12" },
  // The Bank of Japan's hike on 31 Jul 2024 to the 5 Aug low, when the yen carry trade unwound.
  { id: "carry-2024", label: "Carry unwind 2024", start: "2024-07-31", end: "2024-08-05" },
  // The close before the 2 Apr 2025 tariff announcement, after the bell, to the 8 Apr low.
  { id: "tariffs-2025", label: "Tariff drop 2025", start: "2025-04-02", end: "2025-04-08" },
];

/** A boundary close: the last one on or before the day asked for. */
interface DatedClose {
  date: string;
  close: number;
}
/** An episode's two closes, in the listing's own currency (an FX pair's in USD per unit). */
interface EpisodeCloses {
  start: DatedClose;
  end: DatedClose;
}

/**
 * The closes the replays read, kept small enough to cache: each instrument's
 * and each currency's at the start and end of every episode it traded
 * through. An episode missing from an instrument's entry is one it has no
 * closes for (listed later, or halted across a boundary).
 */
export interface RiskEpisodeHistory {
  /** By instrument (riskInstrumentId), then episode. */
  closes: Record<string, Record<string, EpisodeCloses>>;
  /** USD per unit, by currency then episode. */
  fx: Record<string, Record<string, EpisodeCloses>>;
  /** Why an instrument's or a currency's closes did not load, by its id or code. */
  errors: Record<string, string>;
}

/** The episode closes as the model reads them, or what they are waiting on: still loading, or the load's failure. */
export type RiskEpisodeState = RiskEpisodeHistory | { pending: true; error: string | null };

/** A holding to replay: its listing, and the currency it quotes in when that is not USD. */
export interface RiskEpisodeTarget {
  instrument: RiskInstrument;
  /** The listing currency as quoted (GBp, JPY); null for a USD listing. */
  currency: string | null;
}

const DAY_MS = 86_400_000;
/** A boundary close may be this many days before its date: a weekend, a holiday or a market's own closure. */
const BOUNDARY_DAYS = 7;
const EPISODE_CONCURRENCY = 4;
const SPY = RISK_FACTOR_INSTRUMENTS[0]!;

/** The one window every episode fits in, with room for a start date's close a holiday before it. */
function episodeSpan(): { startDate: string; endDate: string } {
  const starts = RISK_EPISODES.map((episode) => episode.start).sort();
  const ends = RISK_EPISODES.map((episode) => episode.end).sort();
  const first = new Date(Date.parse(`${starts[0]}T00:00:00Z`) - (BOUNDARY_DAYS + 3) * DAY_MS);
  return { startDate: first.toISOString().slice(0, 10), endDate: ends.at(-1)! };
}

function closeOnOrBefore(dates: readonly string[], closes: ReadonlyMap<string, number>, day: string): DatedClose | null {
  let low = 0, high = dates.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (dates[middle]! <= day) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return null;
  const date = dates[found]!;
  if (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`) > BOUNDARY_DAYS * DAY_MS) return null;
  return { date, close: closes.get(date)! };
}

/**
 * Each episode's closes from a series of daily closes: the last on or before
 * its start and its end, at most a week before each. A series that starts
 * after an episode's start (listed later) has none for it, and neither does
 * one with no close in the week before a boundary.
 */
export function episodeCloses(points: readonly { date: string; close: number }[]): Record<string, EpisodeCloses> {
  const closes = new Map<string, number>();
  for (const point of points) closes.set(point.date.slice(0, 10), point.close);
  const dates = [...closes.keys()].sort();
  const result: Record<string, EpisodeCloses> = {};
  for (const episode of RISK_EPISODES) {
    const start = closeOnOrBefore(dates, closes, episode.start);
    const end = closeOnOrBefore(dates, closes, episode.end);
    if (start && end && end.date > start.date) result[episode.id] = { start, end };
  }
  return result;
}

/** Positive daily closes from a history answer; an answer without any is a series with none. */
function dailyCloses(response: CloudMarketResponse<CloudPricePointPayload[]>): { date: string; close: number }[] {
  // An empty answer is a listing with no closes in the span (listed after it); the replays proxy it.
  if (response.status === "empty") return [];
  if ((response.status !== "success" && response.status !== "partial") || !Array.isArray(response.data))
    throw new Error(response.reasonCode ?? "Daily history unavailable");
  return response.data.flatMap((row) => {
    const time = typeof row?.date === "string" ? Date.parse(row.date) : Number.NaN;
    return Number.isFinite(time) && Number.isFinite(row.close) && row.close > 0
      ? [{ date: new Date(time).toISOString().slice(0, 10), close: row.close }]
      : [];
  });
}

type EpisodeClient = Pick<typeof apiClient, "getCloudHistory">;
type EpisodeClosesById = Record<string, EpisodeCloses>;

/** How the replays read one listing's or one currency's closes: straight from Gloom Cloud, or through the cache. */
export interface EpisodeReader {
  instrument(instrument: RiskInstrument, signal?: AbortSignal): Promise<EpisodeClosesById>;
  /** USD per unit of the currency. */
  currency(currency: string, signal?: AbortSignal): Promise<EpisodeClosesById>;
}

/**
 * Reads each listing's closes over the one span every episode fits in, one
 * request each, and a currency's from its daily FX pair, as USD per unit.
 */
export function cloudEpisodeReader(client: EpisodeClient = apiClient): EpisodeReader {
  const params = { interval: "1day", ...episodeSpan(), outputsize: 1500 } as const;
  return {
    async instrument(instrument, signal) {
      return episodeCloses(dailyCloses(await client.getCloudHistory(instrument.symbol, instrument.exchange, params, signal ? { signal } : undefined)));
    },
    async currency(currency, signal) {
      const leg = riskConversion(currency)?.leg;
      if (!leg) throw new Error(`No daily FX pair for ${currency}`);
      const points = dailyCloses(await client.getCloudHistory(leg.instrument.symbol, leg.instrument.exchange ?? "", params, signal ? { signal } : undefined));
      return episodeCloses(points.map((point) => ({ ...point, close: leg.invert ? 1 / point.close : point.close })));
    },
  };
}

/**
 * The closes the episode replays read: SPY's, every target's, and the daily
 * FX closes of each currency a target quotes in and of a non-USD account,
 * four reads at a time. A read that fails is named in `errors`, and the
 * replays move that holding by proxy; the signal stops the load.
 */
export async function fetchRiskEpisodeHistory(
  targets: readonly RiskEpisodeTarget[],
  accountCurrency = "USD",
  reader: EpisodeReader = cloudEpisodeReader(),
  signal?: AbortSignal,
): Promise<RiskEpisodeHistory> {
  signal?.throwIfAborted();
  const instruments = [...new Map([SPY, ...targets.map((target) => target.instrument)].map((row) => [riskInstrumentId(row), row])).entries()];
  const currencies = [...new Set([
    ...targets.flatMap((target) => target.currency ? [riskConversion(target.currency)?.currency ?? target.currency] : []),
    ...(accountCurrency === "USD" ? [] : [accountCurrency]),
  ])].filter((currency) => currency !== "USD");
  const history: RiskEpisodeHistory = { closes: {}, fx: {}, errors: {} };
  const read = async (key: string, into: Record<string, EpisodeClosesById>, load: () => Promise<EpisodeClosesById>) => {
    try {
      into[key] = await load();
    } catch (error) {
      if (isAccessDenied(error) || signal?.aborted) throw error;
      history.errors[key] = error instanceof Error ? error.message : "Daily closes unavailable";
    }
  };
  const jobs: Array<() => Promise<void>> = [
    ...instruments.map(([id, instrument]) => () => read(id, history.closes, () => reader.instrument(instrument, signal))),
    ...currencies.map((currency) => () => read(currency, history.fx, () => reader.currency(currency, signal))),
  ];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(EPISODE_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      signal?.throwIfAborted();
      await jobs[next++]!();
    }
  }));
  signal?.throwIfAborted();
  return history;
}

/**
 * One listing's or currency's episode closes. Closes from years ago do not
 * change, and a ratio of two is the same after a later split adjusts both, so
 * they keep for a month; a read that failed is not kept and is asked again.
 */
export const riskEpisodeCache = createPluginCache<EpisodeClosesById>({
  kind: "portfolio-risk-episodes",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 7 * DAY_MS, expireMs: 30 * DAY_MS },
});

/** The episodes' dates are part of every key, so a changed window reads its closes afresh. */
const EPISODE_KEY = RISK_EPISODES.map((episode) => `${episode.start}:${episode.end}`).join(",");

/**
 * The pane's load: each listing and currency through the cache, so a new
 * holding reads only its own closes, and loading again asks only for the
 * ones that failed.
 */
export function loadRiskEpisodeHistory(
  targets: readonly RiskEpisodeTarget[],
  accountCurrency: string,
): Promise<RiskEpisodeHistory> {
  const cloud = cloudEpisodeReader();
  const cached = (key: string, load: () => Promise<EpisodeClosesById>) =>
    loadCloudResource(riskEpisodeCache, `${key}|${EPISODE_KEY}`, load).then((result) => result.payload);
  return fetchRiskEpisodeHistory(targets, accountCurrency, {
    instrument: (instrument, signal) => cached(riskInstrumentId(instrument), () => cloud.instrument(instrument, signal)),
    currency: (currency, signal) => cached(`fx:${currency}`, () => cloud.currency(currency, signal)),
  });
}

/** A basket member as a replay weighs it. */
export interface EpisodeMember {
  id: string;
  symbol: string;
  /** Its share of the basket, which the replay weighs it by. */
  weight: number;
  /** Its current value in the account currency, for its share of the book. */
  value: number;
  /** The listing currency its closes convert from; null for a USD listing. */
  convertedFrom: string | null;
  /** Daily returns in the account currency, which its proxy beta reads. */
  returns: readonly DatedReturn[];
}

export interface EpisodeReplay {
  episode: RiskEpisode;
  /** The basket's return over the window, a fraction; null when the episode could not be replayed. */
  value: number | null;
  /** SPY's own move over the window, in USD. */
  spy: number | null;
  /**
   * Members replayed by their beta to SPY: that beta (1 when `assumed`, the
   * trailing returns pairing with too few of SPY's), their share of the
   * basket the value is a percent of (`weight`) and of the book, and `failed`
   * when their closes did not load rather than not exist.
   */
  proxied: Array<{ id: string; symbol: string; beta: number; assumed: boolean; weight: number; bookShare: number | null; failed: boolean }>;
  /** Why the episode has no value. */
  unavailable: string | null;
}

/** "19 Feb to 23 Mar 2020". */
export function episodeWindowText(episode: RiskEpisode): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
  return `${day(episode.start)}${episode.start.slice(0, 4) === episode.end.slice(0, 4) ? "" : ` ${episode.start.slice(0, 4)}`} to ${day(episode.end)} ${episode.end.slice(0, 4)}`;
}

const signedPercent = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const shareText = (share: number) => (share < 0.001 ? "under 0.1%" : `${formatNumber(share * 100, share < 0.1 ? 1 : 0)}%`);
/** A share in whole percent, for a row label: "22%", "<1%". */
const wholeShareText = (share: number) => (share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`);

/**
 * Replays each episode on today's basket at its current weights: every
 * member moves as it moved between the episode's two closes, converted at the
 * FX closes of the same dates when it quotes in another currency, and the
 * basket's move is the weighted sum. A member with no closes across the
 * window (listed later, or its history did not load) moves by its beta to SPY
 * from its trailing daily returns, the regression the index scenario reads,
 * times SPY's move; it is named with its share of the basket and stays in
 * it. The closes are split-adjusted prices, so a replay is a price return:
 * dividends paid over the window are not in it. A non-USD account's returns
 * convert at its pair's closes of the same dates.
 */
export function replayEpisodes(
  history: RiskEpisodeHistory,
  members: readonly EpisodeMember[],
  {
    spyReturns,
    accountCurrency,
    bookValue,
  }: { spyReturns: readonly DatedReturn[]; accountCurrency: string; bookValue: number },
): EpisodeReplay[] {
  const spyId = riskInstrumentId(SPY);
  const betas = new Map(members.map((member) => [member.id, regressReturns(member.returns.slice(-126), spyReturns)?.beta ?? null]));
  return RISK_EPISODES.map((episode): EpisodeReplay => {
    const empty = (unavailable: string): EpisodeReplay => ({ episode, value: null, spy: null, proxied: [], unavailable });
    const spyCloses = history.closes[spyId]?.[episode.id];
    if (!spyCloses) return empty(history.errors[spyId] ? `SPY daily closes did not load: ${history.errors[spyId]}` : "SPY has no daily closes over the window");
    const spy = spyCloses.end.close / spyCloses.start.close - 1;
    const accountFx = accountCurrency === "USD" ? null : history.fx[accountCurrency]?.[episode.id];
    if (accountCurrency !== "USD" && !accountFx)
      return empty(`${accountFxPair(accountCurrency) ?? accountCurrency} has no daily closes over the window`);
    // A USD move restated in the account currency: its value over the USD price of one unit, at both closes.
    const toAccount = (usd: number) => (accountFx ? (1 + usd) * (accountFx.start.close / accountFx.end.close) - 1 : usd);
    const proxied: EpisodeReplay["proxied"] = [];
    let value = 0;
    for (const member of members) {
      const closes = history.closes[member.id]?.[episode.id];
      const fxCurrency = member.convertedFrom ? riskConversion(member.convertedFrom)?.currency ?? member.convertedFrom : null;
      const fx = fxCurrency ? history.fx[fxCurrency]?.[episode.id] : null;
      let move: number;
      if (closes && (!fxCurrency || fx)) {
        const usd = (closes.end.close * (fx?.end.close ?? 1)) / (closes.start.close * (fx?.start.close ?? 1)) - 1;
        move = toAccount(usd);
      } else {
        // Beta from the account-currency returns on SPY's USD returns, as the index scenario reads it.
        const measured = betas.get(member.id);
        const beta = measured ?? 1;
        const failed = history.errors[member.id] != null || (!!fxCurrency && history.errors[fxCurrency] != null);
        proxied.push({
          id: member.id,
          symbol: member.symbol,
          beta,
          assumed: measured == null,
          weight: member.weight,
          bookShare: bookValue > 0 ? Math.abs(member.value) / bookValue : null,
          failed,
        });
        move = beta * spy;
      }
      value += member.weight * move;
    }
    return { episode, value, spy, proxied, unavailable: null };
  });
}

/** The basket share a replay moves by beta proxy, for a row label where its evidence does not show: "22% proxy". */
export function episodeProxyMarker(replay: EpisodeReplay): string | null {
  const weight = replay.proxied.reduce((sum, row) => sum + Math.abs(row.weight), 0);
  return replay.proxied.length ? `${wholeShareText(weight)} proxy` : null;
}

/**
 * What a replay row says beside its value, a percent of the basket: what is
 * proxied and its share of that basket first, so a narrow column still shows
 * it, then the window, SPY's own move over it, and that it is a price return.
 */
export function episodeEvidence(replay: EpisodeReplay, accountCurrency: string): string {
  if (replay.unavailable) return `% of basket; ${replay.unavailable}; ${episodeWindowText(replay.episode)} closes`;
  const proxies = replay.proxied;
  const weight = proxies.reduce((sum, row) => sum + row.weight, 0);
  const names = proxies.length > 3 ? `${proxies.slice(0, 2).map((row) => row.symbol).join(", ")} and ${proxies.length - 2} more` : proxies.map((row) => row.symbol).join(", ");
  return [
    "% of basket",
    ...(proxies.length ? [`${names} by beta proxy, ${shareText(weight)} of basket`] : []),
    `${episodeWindowText(replay.episode)} closes`,
    `SPY ${signedPercent(replay.spy!)}${accountCurrency === "USD" ? "" : " in USD"}`,
    "price return",
  ].join("; ");
}

/**
 * What the replays leave to say beside their rows: a note per holding a
 * replay moves by proxy because it has no closes over the window (its
 * episodes, its shares of the basket and the book, and its beta), and as
 * warnings what failed to load: a holding's closes, which a proxy then
 * stands in for, or SPY's or the account pair's, which leave an episode
 * without a value.
 */
export function episodeIssues(replays: readonly EpisodeReplay[]): { notes: string[]; warnings: string[] } {
  const byHolding = new Map<string, EpisodeReplay["proxied"][number] & { episodes: string[] }>();
  for (const replay of replays)
    for (const row of replay.proxied) {
      const entry = byHolding.get(row.id) ?? { ...row, episodes: [] };
      entry.episodes.push(replay.episode.label);
      byHolding.set(row.id, entry);
    }
  const notes: string[] = [];
  const warnings: string[] = [];
  for (const row of byHolding.values()) {
    const shares = `${shareText(row.weight)} of the basket${row.bookShare == null ? "" : `, ${shareText(row.bookShare)} of the book`}`;
    const episodes = row.episodes.join(", ");
    const beta = row.assumed ? "an assumed beta of 1 to SPY, too few of its returns pairing with SPY's" : `its beta of ${row.beta.toFixed(2)} to SPY`;
    const moves = `${row.episodes.length === 1 ? "that replay moves" : "those replays move"} it by ${beta}`;
    if (row.failed) warnings.push(`${row.symbol} (${shares}): daily closes for ${episodes} did not load; ${moves}.`);
    else notes.push(`${row.symbol} (${shares}) has no daily closes across ${episodes}; ${moves}.`);
  }
  // One line per reason: SPY failing leaves every episode without a value for the same one.
  const unavailable = new Map<string, string[]>();
  for (const replay of replays)
    if (replay.unavailable) unavailable.set(replay.unavailable, [...(unavailable.get(replay.unavailable) ?? []), replay.episode.label]);
  for (const [reason, episodes] of unavailable)
    warnings.push(`${episodes.length === replays.length ? "Historical episodes" : episodes.join(", ")}: ${reason}.`);
  return { notes, warnings };
}

/**
 * The holdings a replay reads closes for: each held one whose daily history
 * loaded with enough returns for the basket, and the currency it converts
 * from. A held factor ETF counts; the factor proxies alone do not.
 */
export function riskEpisodeTargets(
  market: Pick<RiskMarketSnapshot, "histories">,
  held: readonly RiskInstrument[],
): RiskEpisodeTarget[] {
  const ids = new Set(held.map(riskInstrumentId));
  return market.histories
    .filter((row) => ids.has(riskInstrumentId(row.instrument)) && !row.error && row.returns.length >= 60)
    .map((row) => ({ instrument: row.instrument, currency: row.converted?.currency ?? null }));
}
