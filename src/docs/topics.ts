/**
 * What the DOCS pane can show and how it is addressed: a function's entry, a
 * docs page, an Academy lesson, or the index with a search. Topics travel as
 * short keys (`fn:OMON`, `page:mcp`, `lesson:/academy/...`) so a pane
 * instance can hold one in its params and its back stack in pane state.
 */
import { functionDocsUrl } from "../cli/pane-functions/function-help";
import { DOCS_SITE, type DocsFeed, type DocsFunction, type DocsLessonSummary, type DocsPage } from "./content";

export type DocsTopic =
  | { kind: "home"; query?: string }
  | { kind: "function"; code: string }
  | { kind: "page"; slug: string }
  | { kind: "lesson"; url: string };

export function docsTopicKey(topic: DocsTopic): string {
  switch (topic.kind) {
    case "home": return topic.query ? `home:${topic.query}` : "home";
    case "function": return `fn:${topic.code}`;
    case "page": return `page:${topic.slug}`;
    case "lesson": return `lesson:${topic.url}`;
  }
}

export function parseDocsTopicKey(key: string): DocsTopic | null {
  if (key === "home") return { kind: "home" };
  const split = key.indexOf(":");
  if (split < 0) return null;
  const kind = key.slice(0, split);
  const value = key.slice(split + 1);
  if (!value) return null;
  if (kind === "home") return { kind: "home", query: value };
  if (kind === "fn") return { kind: "function", code: value.toUpperCase() };
  if (kind === "page") return { kind: "page", slug: value };
  if (kind === "lesson" && value.startsWith("/academy/")) return { kind: "lesson", url: value };
  return null;
}

/** The anchor the site's function list gives a mnemonic, as `functionDocsUrl` builds it. */
function functionAnchor(code: string): string {
  return functionDocsUrl(code).split("#")[1] ?? "";
}

export function findDocsFunction(feed: DocsFeed, code: string): DocsFunction | null {
  const wanted = code.toUpperCase();
  return feed.functions.find((fn) => fn.code === wanted) ?? null;
}

export function findDocsPage(feed: DocsFeed, slug: string): DocsPage | null {
  return feed.pages.find((page) => page.slug === slug) ?? null;
}

export function findDocsLesson(feed: DocsFeed, url: string): DocsLessonSummary | null {
  return feed.lessons.find((lesson) => lesson.url === url) ?? null;
}

/** Whether the feed has what the topic names; the index always exists. */
export function docsTopicExists(feed: DocsFeed, topic: DocsTopic): boolean {
  switch (topic.kind) {
    case "home": return true;
    case "function": return findDocsFunction(feed, topic.code) !== null;
    case "page": return findDocsPage(feed, topic.slug) !== null;
    case "lesson": return findDocsLesson(feed, topic.url) !== null;
  }
}

/**
 * A link inside docs text, read in the app when it points at the docs or a
 * lesson. Anything else (the account page, GitHub) returns null: the reader
 * opens it in the browser, and only when it is clicked.
 */
export function docsTopicFromHref(feed: DocsFeed, href: string): DocsTopic | null {
  let path = href.trim();
  if (path.startsWith(DOCS_SITE)) path = path.slice(DOCS_SITE.length) || "/";
  if (!path.startsWith("/")) return null;
  const [pathname = "", hash = ""] = path.split("#");
  const clean = pathname.split("?")[0]!.replace(/\/+$/, "");
  if (clean === "/docs") return { kind: "home" };
  if (clean === "/docs/functions") {
    if (!hash) return { kind: "home" };
    const fn = feed.functions.find((candidate) => functionAnchor(candidate.code) === hash);
    return fn ? { kind: "function", code: fn.code } : { kind: "home" };
  }
  if (clean.startsWith("/docs/")) {
    const slug = clean.slice("/docs/".length);
    return findDocsPage(feed, slug) ? { kind: "page", slug } : null;
  }
  if (clean.startsWith("/academy/") && findDocsLesson(feed, clean)) return { kind: "lesson", url: clean };
  return null;
}

/** The same topic on gloom.sh, for Open in Browser. */
export function docsTopicUrl(topic: DocsTopic): string {
  switch (topic.kind) {
    case "home": return `${DOCS_SITE}/docs`;
    case "function": return functionDocsUrl(topic.code);
    case "page": return `${DOCS_SITE}/docs/${topic.slug}`;
    case "lesson": return `${DOCS_SITE}${topic.url}`;
  }
}

/** Absolute address for a site-relative link in docs text. */
export function docsHrefUrl(href: string): string {
  return href.startsWith("/") ? `${DOCS_SITE}${href}` : href;
}

/** Docs pages that go deeper on a function: those tagged with its mnemonic. */
export function docsPagesForFunction(feed: DocsFeed, code: string): DocsPage[] {
  return feed.pages.filter((page) => page.tags.includes(code));
}

/** One row of the index: a function, a page or a lesson. */
export interface DocsEntry {
  topic: DocsTopic;
  key: string;
  /** The mnemonic, for a function. */
  code?: string;
  title: string;
  about: string;
  section: string;
  /** Searched, never shown. */
  keywords: string;
}

const GUIDES_ORDER = ["Start here", "Understand the data", "Account and teams", "Advanced", "Reference"];
/** The function list is the index; its page would only repeat it. */
const INDEX_PAGES_SKIPPED = new Set(["functions"]);

/**
 * Every entry in reading order: start-here pages, then functions by task,
 * then the other guides, then the Academy by chapter.
 */
export function docsEntries(feed: DocsFeed): DocsEntry[] {
  const pages = feed.pages
    .filter((page) => !INDEX_PAGES_SKIPPED.has(page.slug))
    .map((page): DocsEntry => {
      const topic: DocsTopic = { kind: "page", slug: page.slug };
      return {
        topic,
        key: docsTopicKey(topic),
        title: page.title,
        about: page.lead,
        section: page.category || "Guides",
        keywords: page.tags.join(" "),
      };
    });
  const pageRank = (entry: DocsEntry) => {
    const rank = GUIDES_ORDER.indexOf(entry.section);
    return rank < 0 ? GUIDES_ORDER.length : rank;
  };
  const startHere = pages.filter((entry) => entry.section === GUIDES_ORDER[0]);
  const guides = pages.filter((entry) => entry.section !== GUIDES_ORDER[0])
    .sort((left, right) => pageRank(left) - pageRank(right));
  const categoryTitle = new Map(feed.categories.map((category) => [category.id, category.title]));
  const categoryRank = new Map(feed.categories.map((category, index) => [category.id, index]));
  const functions = feed.functions
    .map((fn, index) => ({ fn, index }))
    .sort((left, right) => (
      (categoryRank.get(left.fn.category) ?? 99) - (categoryRank.get(right.fn.category) ?? 99) || left.index - right.index
    ))
    .map(({ fn }): DocsEntry => {
      const topic: DocsTopic = { kind: "function", code: fn.code };
      return {
        topic,
        key: docsTopicKey(topic),
        code: fn.code,
        title: fn.name,
        about: fn.description,
        section: categoryTitle.get(fn.category) ?? "Functions",
        keywords: `${fn.detail} ${fn.plugin?.name ?? ""}`,
      };
    });
  const lessons = feed.lessons.map((lesson): DocsEntry => {
    const topic: DocsTopic = { kind: "lesson", url: lesson.url };
    return {
      topic,
      key: docsTopicKey(topic),
      title: lesson.title,
      about: lesson.summary,
      section: `Academy: ${lesson.chapter}`,
      keywords: lesson.chapter,
    };
  });
  return [...startHere, ...functions, ...guides, ...lessons];
}

function entryScore(entry: DocsEntry, terms: string[], phrase: string): number {
  const title = entry.title.toLowerCase();
  const text = `${title} ${entry.about.toLowerCase()} ${entry.keywords.toLowerCase()}`;
  let score = title === phrase ? 6 : 0;
  for (const term of terms) {
    const upper = term.toUpperCase();
    if (entry.code === upper) score += 12;
    else if (entry.code?.startsWith(upper)) score += 4;
    else if (title.split(/[^a-z0-9]+/).some((word) => word.startsWith(term))) score += 3;
    else if (text.includes(term)) score += 1;
    else return 0;
  }
  // Functions and pages answer "what is this" before a lesson teaches it.
  return score + (entry.topic.kind === "lesson" ? 0 : 0.5);
}

/**
 * Entries matching every word, best first: a mnemonic before a title word
 * before a mention. An empty query lists everything in reading order.
 */
export function searchDocsEntries(entries: readonly DocsEntry[], query: string): DocsEntry[] {
  const phrase = query.trim().toLowerCase();
  if (!phrase) return [...entries];
  const terms = phrase.split(/\s+/).filter(Boolean);
  return entries
    .map((entry, index) => ({ entry, index, score: entryScore(entry, terms, phrase) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry);
}
