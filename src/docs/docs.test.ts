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
    expect(offline.offline).toBe(true);
    expect(offline.feed.functions.map((fn) => fn.code)).toEqual(["GP", "OMON", "DOCS"]);
  });

  test("with nothing kept and no site, reads the copy the app shipped with", async () => {
    const result = await loadDocsFeed();
    expect(result.offline).toBe(true);
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
