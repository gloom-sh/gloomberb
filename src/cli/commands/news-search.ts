import { apiClient } from "../../api-client";
import type { NewsArticle } from "../../news/types";
import { mapCloudNewsArticle } from "../../sources/gloomberb-cloud/news";
import { cliStyles } from "../../utils/cli-output";

/** What the service accepts of a search: two characters to two hundred, with a letter or a number in them. */
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = 200;
const MIN_FALLBACK_LENGTH = 3;

/**
 * The text `news` was asked to search for rather than a symbol: several words,
 * quoted or not (`news "european gas"`, `news european gas`), or one word that
 * still carries its quotes (`news '"gold"'`: a shell drops one pair, so the
 * word keeps the inner pair). A bare word is a symbol until nothing answers
 * to it (`newsFallbackText`).
 */
export function newsSearchText(args: readonly string[]): string | null {
  const text = args.join(" ").trim().replace(/\s+/g, " ");
  const quoted = args.length === 1 ? /^(["'“‘])(.+)(["'”’])$/u.exec(text) : null;
  if (quoted) return quoted[2]!.trim();
  return args.length > 1 || /\s/.test(text) ? text : null;
}

/** How to type a word as text to search from a shell: `'"gold"'` keeps the quotes a shell would drop. */
export const quotedSearchCommand = (word: string) => `gloomberb news '"${word}"'`;

/**
 * Whether a word typed for `news` may mean more than the listing it found:
 * a plain word (letters only, three or more, typed with a lower-case letter,
 * as a word is and a ticker rarely is) that is one of the words of the
 * company's name ("gold" for Gold.com Inc., "gap" for The Gap). The stories
 * then decide (`wordMeansMore`).
 */
export function commonWordCandidate(typed: string, companyName: string | null | undefined): boolean {
  const word = typed.trim();
  if (!/^[A-Za-z]{3,}$/.test(word) || !/[a-z]/.test(word) || !companyName) return false;
  return companyName.toLowerCase().split(/[^a-z]+/).includes(word.toLowerCase());
}

/**
 * Whether the stories that mention a word are mostly about something else
 * than the ticker it resolved to: three or more stories, fewer than half of
 * them filed under the ticker. "gold" is mostly the metal's market; "meta"
 * is mostly Meta Platforms.
 */
export function wordMeansMore(stories: readonly NewsArticle[], symbol: string): boolean {
  if (stories.length < 3) return false;
  const ticker = symbol.toUpperCase();
  const filed = stories.filter((story) => (story.tickers ?? []).some((entry) => entry.toUpperCase() === ticker)).length;
  return filed * 2 < stories.length;
}

/** Why the service would refuse the text, or null when it can search it. */
export function newsSearchTextProblem(text: string): string | null {
  if (text.length < MIN_TEXT_LENGTH || !/[\p{L}\p{N}]/u.test(text)) return "Search text needs at least two characters, with a letter or a number.";
  if (text.length > MAX_TEXT_LENGTH) return `Search text is limited to ${MAX_TEXT_LENGTH} characters.`;
  return null;
}

/**
 * The word a symbol lookup found no stories for, as text to search stories for.
 * Null under three characters, where the fuzzy match finds names that merely
 * contain it (ZN, Telomir-Zn) and the lookup's own answer is the better one.
 */
export function newsFallbackText(symbol: string): string | null {
  const text = symbol.trim().replace(/^\$/, "");
  return text.length < MIN_FALLBACK_LENGTH || newsSearchTextProblem(text) ? null : text;
}

/**
 * The stories matching the text, newest first. The service answers best match
 * first and holds stories back from an account without real-time access, as
 * every other news request.
 */
export async function searchNewsStories(text: string, limit: number): Promise<NewsArticle[]> {
  const response = await apiClient.searchCloudNews(text, limit);
  return response.items
    .map((item) => mapCloudNewsArticle(item))
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

/** The line above the stories: "Stories matching "european gas"", with why a word typed as a symbol is searched. */
export function newsSearchHeading(text: string, reason?: string): string {
  return `${cliStyles.bold(`Stories matching "${text}"`)}${reason ? cliStyles.muted(`  ·  ${reason}`) : ""}`;
}
