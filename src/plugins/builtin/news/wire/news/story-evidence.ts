import type { NewsInsiderFiling, NewsStoryItem } from "../../../../../news/types";
import { formatCurrency, formatNumber } from "../../../../../utils/format";
import { formatShortDate } from "../../../../../utils/datetime-format";
import { formatInsiderName } from "../../../insider/display";

/*
 * What a story's own page holds besides its text: the outlets that covered it,
 * the most relevant to it first, and, for a story about insiders trading, the
 * Form 4 filings it reports, each insider's filings together with their total.
 */

/** Words that name nothing a story is about. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have", "he", "her",
  "his", "in", "into", "is", "it", "its", "of", "on", "or", "over", "said", "says", "she", "than", "that", "the",
  "their", "them", "they", "this", "to", "was", "were", "which", "while", "who", "will", "with", "also", "after",
  "about", "more", "most", "nearly", "new", "some", "such", "these", "those", "million", "billion", "percent",
]);

/** A word as a story and its coverage share it: lower case, a plural's s left off. */
function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function words(text: string): string[] {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The words a story is about, weighted: a name (a word its own text
 * capitalises after the start of a sentence, Stevens, Nvidia, Q3) counts twice
 * what any other word does.
 */
function storyTerms(title: string, summary: string | undefined): Map<string, number> {
  const text = `${title}. ${summary ?? ""}`;
  const names = new Set<string>();
  for (const sentence of text.split(/[.!?:]\s+/)) {
    sentence.split(/\s+/).slice(1).forEach((raw) => {
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (/^\p{Lu}/u.test(word)) for (const part of words(word)) names.add(stem(part));
    });
  }
  const terms = new Map<string, number>();
  for (const word of words(text)) {
    if (STOP_WORDS.has(word) || (word.length < 3 && !/\d/.test(word))) continue;
    const term = stem(word);
    terms.set(term, names.has(term) ? 2 : 1);
  }
  return terms;
}

/** The share of a story's weighted words an outlet's headline and summary also use, from 0 to 1. */
function coverageRelevance(item: Pick<NewsStoryItem, "title" | "summary">, terms: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const weight of terms.values()) total += weight;
  if (total === 0) return 0;
  const used = new Set(words(`${item.title} ${item.summary ?? ""}`).map(stem));
  let shared = 0;
  for (const [term, weight] of terms) if (used.has(term)) shared += weight;
  return shared / total;
}

function itemTime(item: NewsStoryItem): number {
  const time = new Date(item.publishedAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * A story's coverage, the outlets that tell its story first: by the share of
 * the story's words (its names counting double) each one's headline and summary
 * use, the newest first among equals. A post the story took in that is about
 * something wider (a sector's insider ratio under a story about one director's
 * sales) goes after the reports of the story itself.
 */
export function rankStoryCoverage(
  items: readonly NewsStoryItem[] | undefined,
  story: { title: string; summary?: string },
): NewsStoryItem[] {
  const terms = storyTerms(story.title, story.summary);
  return [...(items ?? [])]
    .map((item) => ({ item, relevance: Math.round(coverageRelevance(item, terms) * 100) }))
    .sort((a, b) => b.relevance - a.relevance || itemTime(b.item) - itemTime(a.item))
    .map(({ item }) => item);
}

/** One insider's filings a story reports, at one company, on one side. */
export interface InsiderFilingGroup {
  key: string;
  /** As filed (STEVENS MARK A): what INS filters by. */
  insider: string;
  /** As read (Mark A. Stevens). */
  name: string;
  title: string | null;
  ticker: string | null;
  issuerName: string | null;
  side: NewsInsiderFiling["side"];
  filings: NewsInsiderFiling[];
  lines: number;
  shares: number;
  value: number;
  firstTradeDate: string;
  lastTradeDate: string;
}

/** The filings by insider, company and side, in the order the story's service ranks them (the largest first). */
export function groupInsiderFilings(filings: readonly NewsInsiderFiling[]): InsiderFilingGroup[] {
  const groups = new Map<string, InsiderFilingGroup>();
  for (const filing of filings) {
    const key = `${filing.insider}\n${filing.ticker ?? filing.issuerName ?? ""}\n${filing.side}`;
    const group = groups.get(key) ?? {
      key,
      insider: filing.insider,
      name: formatInsiderName(filing.insider),
      title: filing.title,
      ticker: filing.ticker,
      issuerName: filing.issuerName,
      side: filing.side,
      filings: [],
      lines: 0,
      shares: 0,
      value: 0,
      firstTradeDate: filing.firstTradeDate,
      lastTradeDate: filing.lastTradeDate,
    };
    group.filings.push(filing);
    group.lines += filing.lines;
    group.shares += filing.shares;
    group.value += filing.value;
    if (filing.firstTradeDate < group.firstTradeDate) group.firstTradeDate = filing.firstTradeDate;
    if (filing.lastTradeDate > group.lastTradeDate) group.lastTradeDate = filing.lastTradeDate;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** `18 Sep 2026`; a span `31 Aug–2 Sep 2026`, the year once when both days share it. */
export function tradeDaySpan(first: string, last: string): string {
  const day = (date: string, year: boolean) => formatShortDate(`${date}T00:00:00Z`, { utc: true, year: year ? "numeric" : false });
  if (first === last) return day(first, true);
  // The month once too when both days are in it: 3–4 Sep 2026.
  if (first.slice(0, 7) === last.slice(0, 7)) return `${Number(first.slice(8, 10))}–${day(last, true)}`;
  return `${day(first, first.slice(0, 4) !== last.slice(0, 4))}–${day(last, true)}`;
}

/** Whether the lines were traded under a Rule 10b5-1 plan, as the filing says, or that it does not say. */
function planText(rule10b51: boolean | null): string {
  return rule10b51 === true ? "10b5-1 plan" : rule10b51 === false ? "no 10b5-1 plan" : "10b5-1 not stated";
}

const shareCount = (shares: number) => formatNumber(shares, Number.isInteger(shares) ? 0 : 4);
const dollars = (value: number) => formatCurrency(value, "USD", 2);
/** A weighted average to the four places Form 4 prices are filed to. */
const averagePrice = (price: number) => formatCurrency(price, "USD", 4);

/**
 * One filing as its lines add up: `Sold 1,366,000 shares at avg $219.727,
 * traded 18 Sep 2026, 2 lines, no 10b5-1 plan`.
 */
export function insiderFilingSummary(filing: NewsInsiderFiling): string {
  return [
    `${filing.side === "sale" ? "Sold" : "Bought"} ${shareCount(filing.shares)} shares at avg ${averagePrice(filing.weightedPrice)}`,
    `traded ${tradeDaySpan(filing.firstTradeDate, filing.lastTradeDate)}`,
    `${filing.lines} ${filing.lines === 1 ? "line" : "lines"}`,
    planText(filing.rule10b51),
  ].join(", ");
}

/** An insider's filings in all: `4,236,740 shares for $946,627,633.48 in 3 Form 4s, traded 31 Aug–18 Sep 2026`. */
export function insiderGroupTotal(group: InsiderFilingGroup): string {
  const count = group.filings.length;
  return `${group.side === "sale" ? "Sold" : "Bought"} ${shareCount(group.shares)} shares for ${dollars(group.value)} in ${count} Form ${count === 1 ? "4" : "4s"}, traded ${tradeDaySpan(group.firstTradeDate, group.lastTradeDate)}`;
}

/** Who and where: `Mark A. Stevens · Director · NVDA`. */
export function insiderGroupHeading(group: InsiderFilingGroup): string {
  return [group.name, group.title, group.ticker ?? group.issuerName].filter(Boolean).join(" · ");
}
