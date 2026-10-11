/**
 * The docs and the Academy as gloom.sh publishes them for the app: one
 * source, read in the DOCS pane instead of a browser. The site serves the
 * index (every function, every docs page, the Academy outline) at
 * `/api/app-docs` and one lesson at `/api/app-docs/academy/<lesson>`, as JSON
 * blocks of markdown text. Nothing here is HTML and nothing is executed:
 * blocks are drawn with the app's own components, and an unknown block or
 * field is dropped rather than shown.
 */

export const DOCS_SITE = "https://gloom.sh";
export const DOCS_FEED_URL = `${DOCS_SITE}/api/app-docs`;
/** The feed shape this app reads; a newer major shape falls back to the saved copy. */
const DOCS_FEED_FORMAT = 1;
/** The DOCS pane's template, for the chrome and the help card to open it by id. */
export const DOCS_PANE_TEMPLATE_ID = "docs-pane";

export type DocsBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "list"; ordered?: boolean; start?: number; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; code: string }
  | { type: "image"; src: string; alt: string; caption?: string }
  | { type: "diagram"; alt: string; light: string; dark: string; steps?: string[] }
  | { type: "callout"; kind?: string; blocks: DocsBlock[] }
  | { type: "details"; summary: string; blocks: DocsBlock[] };

export interface DocsFunction {
  code: string;
  name: string;
  description: string;
  detail: string;
  category: string;
  arg?: string;
  access?: "pro" | "cloud";
  plugin?: { id: string; name: string };
  /** Screenshot URL on gloom.sh. */
  shot?: string;
  /** The Academy lesson that teaches it, as a site path. */
  lesson?: string;
}

export interface DocsPage {
  slug: string;
  title: string;
  lead: string;
  category: string;
  tags: string[];
  updatedAt?: string;
  blocks: DocsBlock[];
}

export interface DocsLessonSummary {
  /** `/academy/<chapter>/<section>/<lesson>` */
  url: string;
  title: string;
  summary: string;
  chapter: string;
  minutes: number;
}

export interface DocsLesson extends DocsLessonSummary {
  blocks: DocsBlock[];
}

export interface DocsFeed {
  /** The newest page date, `YYYY-MM-DD`. */
  updatedAt: string;
  categories: Array<{ id: string; title: string }>;
  functions: DocsFunction[];
  pages: DocsPage[];
  lessons: DocsLessonSummary[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
/** An image only ever comes from the site itself, over https. */
const siteImage = (value: unknown): value is string => text(value) && value.startsWith(`${DOCS_SITE}/`);

function parseBlock(raw: unknown): DocsBlock | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "paragraph":
      return text(raw.text) ? { type: "paragraph", text: raw.text } : null;
    case "heading":
      return text(raw.text) ? { type: "heading", level: raw.level === 3 ? 3 : 2, text: raw.text } : null;
    case "list":
      if (!texts(raw.items)) return null;
      return {
        type: "list",
        items: raw.items,
        ...(raw.ordered === true ? { ordered: true } : {}),
        ...(typeof raw.start === "number" && Number.isInteger(raw.start) ? { start: raw.start } : {}),
      };
    case "table":
      if (!texts(raw.headers) || !Array.isArray(raw.rows) || !raw.rows.every(texts)) return null;
      return { type: "table", headers: raw.headers, rows: raw.rows as string[][] };
    case "code":
      return text(raw.code) ? { type: "code", code: raw.code } : null;
    case "image":
      if (!siteImage(raw.src)) return null;
      return {
        type: "image",
        src: raw.src,
        alt: text(raw.alt) ? raw.alt : "",
        ...(text(raw.caption) ? { caption: raw.caption } : {}),
      };
    case "diagram":
      if (!siteImage(raw.light) || !siteImage(raw.dark)) return null;
      return {
        type: "diagram",
        alt: text(raw.alt) ? raw.alt : "",
        light: raw.light,
        dark: raw.dark,
        ...(texts(raw.steps) ? { steps: raw.steps } : {}),
      };
    case "callout":
      return {
        type: "callout",
        ...(text(raw.kind) ? { kind: raw.kind } : {}),
        blocks: parseBlocks(raw.blocks),
      };
    case "details":
      return text(raw.summary) ? { type: "details", summary: raw.summary, blocks: parseBlocks(raw.blocks) } : null;
    default:
      return null;
  }
}

function parseBlocks(raw: unknown): DocsBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseBlock).filter((block): block is DocsBlock => block !== null);
}

function parseFunction(raw: unknown): DocsFunction | null {
  if (!isRecord(raw) || !text(raw.code) || !text(raw.name) || !text(raw.description) || !text(raw.detail)) return null;
  const plugin = isRecord(raw.plugin) && text(raw.plugin.id) && text(raw.plugin.name)
    ? { id: raw.plugin.id, name: raw.plugin.name }
    : undefined;
  return {
    code: raw.code.toUpperCase(),
    name: raw.name,
    description: raw.description,
    detail: raw.detail,
    category: text(raw.category) ? raw.category : "",
    ...(text(raw.arg) ? { arg: raw.arg } : {}),
    ...(raw.access === "pro" || raw.access === "cloud" ? { access: raw.access } : {}),
    ...(plugin ? { plugin } : {}),
    ...(siteImage(raw.shot) ? { shot: raw.shot } : {}),
    ...(text(raw.lesson) && raw.lesson.startsWith("/academy/") ? { lesson: raw.lesson } : {}),
  };
}

function parsePage(raw: unknown): DocsPage | null {
  if (!isRecord(raw) || !text(raw.slug) || !text(raw.title)) return null;
  return {
    slug: raw.slug,
    title: raw.title,
    lead: text(raw.lead) ? raw.lead : "",
    category: text(raw.category) ? raw.category : "",
    tags: texts(raw.tags) ? raw.tags : [],
    ...(text(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    blocks: parseBlocks(raw.blocks),
  };
}

function parseLessonSummary(raw: unknown): DocsLessonSummary | null {
  if (!isRecord(raw) || !text(raw.url) || !raw.url.startsWith("/academy/") || !text(raw.title)) return null;
  return {
    url: raw.url,
    title: raw.title,
    summary: text(raw.summary) ? raw.summary : "",
    chapter: text(raw.chapter) ? raw.chapter : "",
    minutes: typeof raw.minutes === "number" && Number.isFinite(raw.minutes) ? raw.minutes : 0,
  };
}

function compact<T>(values: unknown, parse: (raw: unknown) => T | null): T[] {
  return Array.isArray(values) ? values.map(parse).filter((value): value is T => value !== null) : [];
}

/** The index as the site sent it, or null when it is not a feed this app can read. */
export function parseDocsFeed(raw: unknown): DocsFeed | null {
  if (!isRecord(raw) || raw.format !== DOCS_FEED_FORMAT) return null;
  const functions = compact(raw.functions, parseFunction);
  const pages = compact(raw.pages, parsePage);
  // A feed with nothing to read is a broken response, not an empty manual.
  if (functions.length === 0 || pages.length === 0) return null;
  return {
    updatedAt: text(raw.updatedAt) ? raw.updatedAt : "",
    categories: compact(raw.categories, (category) => (
      isRecord(category) && text(category.id) && text(category.title) ? { id: category.id, title: category.title } : null
    )),
    functions,
    pages,
    lessons: compact(raw.lessons, parseLessonSummary),
  };
}

export function parseDocsLesson(raw: unknown): DocsLesson | null {
  if (!isRecord(raw) || raw.format !== DOCS_FEED_FORMAT) return null;
  const summary = parseLessonSummary(raw);
  if (!summary) return null;
  const blocks = parseBlocks(raw.blocks);
  return blocks.length > 0 ? { ...summary, blocks } : null;
}

/** Where the site serves one lesson's blocks. */
export function docsLessonFeedUrl(url: string): string {
  return `${DOCS_SITE}/api/app-docs${url}`;
}
