import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../test-support/plugin-persistence";
import { parseDocsFeed, type DocsFeed } from "./content";
import { attachDocsPersistence, loadDocsFeed, loadDocsLesson, resetDocsPersistence, setDocsFetchForTests } from "./load";
import { DOCS_FIXTURE_LESSON_URL, docsFeedFixture, docsLessonFixture } from "./test-fixture";
import { docsEntries, docsTopicFromHref, searchDocsEntries } from "./topics";

const feed = parseDocsFeed(docsFeedFixture()) as DocsFeed;

describe("reading the site's docs", () => {
  test("keeps only what the app can draw, and only pictures from the site", () => {
    const parsed = parseDocsFeed(docsFeedFixture({
      functions: [
        ...docsFeedFixture().functions,
        { code: "EVIL", name: "Off-site shot", description: "x", detail: "x", category: "research", shot: "https://example.com/x.png" },
      ],
    }))!;
    expect(parsed.pages[0]!.blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list"]);
    expect(parsed.functions.find((fn) => fn.code === "EVIL")?.shot).toBeUndefined();
    expect(parsed.functions.find((fn) => fn.code === "GP")?.shot).toBe("https://gloom.sh/screenshots/fn/GP.png");
    // A newer shape, or a response with nothing in it, is not a manual.
    expect(parseDocsFeed(docsFeedFixture({ format: 2 }))).toBeNull();
    expect(parseDocsFeed(docsFeedFixture({ functions: [] }))).toBeNull();
  });

  test("a link reads in the app when it names a page, a function or a lesson", () => {
    expect(docsTopicFromHref(feed, "/docs/layout-shortcuts")).toEqual({ kind: "page", slug: "layout-shortcuts" });
    expect(docsTopicFromHref(feed, "https://gloom.sh/docs/functions#omon")).toEqual({ kind: "function", code: "OMON" });
    expect(docsTopicFromHref(feed, "/docs/functions")).toEqual({ kind: "home" });
    expect(docsTopicFromHref(feed, DOCS_FIXTURE_LESSON_URL)).toEqual({ kind: "lesson", url: DOCS_FIXTURE_LESSON_URL });
    // Anywhere else leaves the app, and only when clicked.
    expect(docsTopicFromHref(feed, "/cloud")).toBeNull();
    expect(docsTopicFromHref(feed, "/docs/no-such-page")).toBeNull();
    expect(docsTopicFromHref(feed, "https://github.com/gloom-sh/gloomberb")).toBeNull();
  });

  test("a search needs every word, and puts a mnemonic before a title before a mention", () => {
    const entries = docsEntries(feed);
    expect(searchDocsEntries(entries, "gp").map((entry) => entry.key)[0]).toBe("fn:GP");
    expect(searchDocsEntries(entries, "price chart").map((entry) => entry.key)).toEqual(["fn:GP", `lesson:${DOCS_FIXTURE_LESSON_URL}`]);
    expect(searchDocsEntries(entries, "chart strike")).toEqual([]);
    expect(searchDocsEntries(entries, "greeks").map((entry) => entry.key)).toEqual(["fn:OMON"]);
  });
});

describe("grouping the docs index", () => {
  const withPages = (...pages: Array<[slug: string, category: string]>) => parseDocsFeed(docsFeedFixture({
    pages: pages.map(([slug, category]) => ({ slug, title: slug, lead: "", category, tags: [], blocks: [] })),
  })) as DocsFeed;
  const pageSections = (docs: DocsFeed) => docsEntries(docs)
    .filter((entry) => entry.topic.kind === "page")
    .map((entry) => `${entry.section}: ${entry.key}`);

  test("lists the groups in the order the site does, developer groups after the app's", () => {
    const docs = withPages(
      ["getting-started", "Start here"],
      ["portfolio", "Using Gloom"],
      ["teams", "Account and teams"],
      ["company-kpis", "Understand the data"],
      ["themes", "Reference"],
      ["developers", "Developers"],
      ["cli-functions", "Command line"],
      ["mcp", "Agents"],
      ["datasets", "APIs and data"],
      ["plugins", "Extend"],
    );
    expect(docsEntries(docs).map((entry) => entry.key)).toEqual([
      "page:getting-started",
      "fn:GP",
      "fn:OMON",
      "fn:DOCS",
      "page:portfolio",
      "page:teams",
      "page:company-kpis",
      "page:themes",
      "page:developers",
      "page:cli-functions",
      "page:mcp",
      "page:datasets",
      "page:plugins",
      `lesson:${DOCS_FIXTURE_LESSON_URL}`,
    ]);
  });

  test("follows whatever order the feed arrives in, keeping Start here first and each group together", () => {
    const docs = withPages(
      ["themes", "Reference"],
      ["first-session", "Start here"],
      ["recipes", "Cookbook"],
      ["troubleshooting", "Reference"],
      ["tips", "Cookbook"],
      ["getting-started", "Start here"],
    );
    expect(pageSections(docs)).toEqual([
      "Start here: page:first-session",
      "Start here: page:getting-started",
      "Reference: page:themes",
      "Reference: page:troubleshooting",
      "Cookbook: page:recipes",
      "Cookbook: page:tips",
    ]);
  });

  test("an older feed, with Advanced and no Using Gloom, still lists every page under its own group", () => {
    const docs = withPages(
      ["getting-started", "Start here"],
      ["portfolio", "Start here"],
      ["teams", "Account and teams"],
      ["company-kpis", "Understand the data"],
      ["layout-shortcuts", "Reference"],
      ["cli-functions", "Advanced"],
      ["plugins", "Advanced"],
      ["loose-page", ""],
    );
    expect(pageSections(docs)).toEqual([
      "Start here: page:getting-started",
      "Start here: page:portfolio",
      "Account and teams: page:teams",
      "Understand the data: page:company-kpis",
      "Reference: page:layout-shortcuts",
      "Advanced: page:cli-functions",
      "Advanced: page:plugins",
      "Guides: page:loose-page",
    ]);
  });
});

describe("loading the docs", () => {
  let site: (url: string) => Promise<unknown>;
  beforeEach(() => {
    resetDocsPersistence();
    attachDocsPersistence(new MemoryPluginPersistence());
    site = async () => { throw new Error("offline"); };
    setDocsFetchForTests((url) => site(url));
  });
  afterEach(() => {
    setDocsFetchForTests(null);
    resetDocsPersistence();
  });

  test("reads the site, keeps it, and reads the kept copy when the site goes away", async () => {
    site = async () => docsFeedFixture();
    const online = await loadDocsFeed();
    expect(online.offline).toBe(false);
    expect(online.feed.functions.map((fn) => fn.code)).toEqual(["GP", "OMON", "DOCS"]);
    site = async () => { throw new Error("offline"); };
    const offline = await loadDocsFeed({ force: true });
    expect(offline).toMatchObject({ offline: true, bundled: false });
    expect(offline.feed.functions.map((fn) => fn.code)).toEqual(["GP", "OMON", "DOCS"]);
  });

  test("with nothing kept and no site, reads the copy the app shipped with", async () => {
    const result = await loadDocsFeed();
    expect(result).toMatchObject({ offline: true, bundled: true });
    expect(result.feed.functions.length).toBeGreaterThan(100);
  });

  test("a kept copy older than the shipped one loses to it", async () => {
    site = async () => docsFeedFixture({ updatedAt: "2000-01-01" });
    const result = await loadDocsFeed();
    expect(result.offline).toBe(false);
    expect(result.feed.functions.length).toBeGreaterThan(100);
  });

  test("a lesson read once stays readable offline; one never read is unavailable", async () => {
    site = async () => docsLessonFixture();
    expect((await loadDocsLesson(DOCS_FIXTURE_LESSON_URL)).offline).toBe(false);
    site = async () => { throw new Error("offline"); };
    const kept = await loadDocsLesson(DOCS_FIXTURE_LESSON_URL, { force: true });
    expect(kept).toMatchObject({ offline: true, lesson: { title: "Reading a price chart (GP)" } });
    await expect(loadDocsLesson("/academy/never/read")).rejects.toThrow();
  });
});
