import type { EarningsCalendarReport } from "../../../api-client/earnings";
import type { EconEvent } from "../econ/types";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import { usSessionAt } from "../market-movers/session";
import type { NewsArticle } from "../../../news/types";
import { zonedDateKey } from "../../../utils/zoned-date-time";

export const BRIEF_FUTURES = ["ES=F", "NQ=F", "CL=F"] as const;
const HEADLINE_CAP = 8;
const NEW_YORK = "America/New_York";

interface BriefSession {
  date: string;
  phase: "pre" | "regular" | "post" | "closed";
}

interface BriefMarketRow {
  symbol: string;
  label: string;
  last: number | null;
  changePercent: number | null;
}

interface BriefHeadline {
  articleId: string;
  title: string;
  source: string;
  url: string | null;
  publishedAt: string;
}

interface BriefEvent {
  id: string;
  at: string;
  kind: "earnings" | "economic";
  label: string;
  symbol: string | null;
  /** Company name for an earnings row. Empty when the calendar only has the ticker. */
  name: string | null;
  /** Consensus for an earnings row. Null on a release, and when the calendar has no figure. */
  epsEstimate: number | null;
  revenueEstimate: number | null;
}

export interface Brief {
  session: BriefSession;
  asOf: string | null;
  markets: BriefMarketRow[];
  headlines: BriefHeadline[];
  events: BriefEvent[];
}

interface BriefQuote {
  last: number | null;
  changePercent: number | null;
}

export interface BriefSlices {
  now: number;
  quotes: ReadonlyMap<string, BriefQuote>;
  articles: readonly NewsArticle[];
  earnings: readonly (Pick<EarningsCalendarReport, "symbol" | "date" | "timing" | "epsEstimate" | "revenueEstimate"> & { name?: string | null })[];
  econ: readonly EconEvent[];
  fetchedAt: readonly (number | string | null | undefined)[];
}

function publishedAtIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function oldestIso(values: readonly (number | string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const value of values) {
    if (value == null || value === "") continue;
    const ms = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (best == null || ms < best) best = ms;
  }
  return best == null ? null : new Date(best).toISOString();
}

export function assembleBrief(input: BriefSlices): Brief {
  const session = usSessionAt(input.now);
  const contracts = new Map(FUTURES_CONTRACTS.map((contract) => [contract.symbol, contract]));
  const markets = BRIEF_FUTURES.map((symbol) => {
    const contract = contracts.get(symbol);
    if (!contract) throw new Error(`missing futures contract ${symbol}`);
    const quote = input.quotes.get(symbol);
    return {
      symbol,
      label: contract.code,
      last: quote?.last ?? null,
      changePercent: quote?.changePercent ?? null,
    };
  });
  const headlines = input.articles.slice(0, HEADLINE_CAP).map((article) => ({
    articleId: article.id,
    title: article.title,
    source: article.source,
    url: article.url || null,
    publishedAt: publishedAtIso(article.publishedAt),
  }));
  const earnings: BriefEvent[] = [];
  for (const report of input.earnings) {
    if (report.date !== session.date) continue;
    const company = report.name?.trim() ?? "";
    earnings.push({
      id: `${report.symbol}:${report.date}`,
      at: report.timing ?? "99:99",
      kind: "earnings",
      label: company || report.symbol,
      symbol: report.symbol,
      name: company && company !== report.symbol ? company : null,
      epsEstimate: report.epsEstimate ?? null,
      revenueEstimate: report.revenueEstimate ?? null,
    });
  }
  // Before the open, during the session, after the close, then a report with no time.
  const timingOrder = (at: string) => at === "bmo" ? 0 : at === "dmh" ? 1 : at === "amc" ? 2 : 3;
  earnings.sort((a, b) => timingOrder(a.at) - timingOrder(b.at) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));
  const economic: BriefEvent[] = [];
  for (const event of input.econ) {
    if (zonedDateKey(event.date.getTime(), NEW_YORK) !== session.date) continue;
    economic.push({
      id: event.id,
      at: event.time,
      kind: "economic",
      label: `${event.country} ${event.event}`,
      symbol: null,
      name: null,
      epsEstimate: null,
      revenueEstimate: null,
    });
  }
  economic.sort((a, b) => a.at.localeCompare(b.at) || a.label.localeCompare(b.label));
  const events = [...economic, ...earnings];
  return {
    session: { date: session.date, phase: session.phase },
    asOf: oldestIso(input.fetchedAt),
    markets,
    headlines,
    events,
  };
}
