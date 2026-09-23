import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { NewsService } from "../../../../../news/aggregator";
import { setSharedNewsService } from "../../../../../news/hooks";
import { newsProvider } from "../../../../../capabilities";
import { NewsPresetPane } from "./preset-pane";
import { testRender, settleFrame, emitKeypress } from "../../../../../renderers/opentui/test-utils";
import { TestPaneProvider, createTestPaneConfig } from "../../../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { createInitialState, appReducer } from "../../../../../state/app/context";
import { PaneFooterProvider, PaneFooterBar } from "../../../../../components/layout/pane/footer";
import { formatDetailDate } from "../../../../../utils/datetime-format";
import type { NewsArticle } from "../../../../../news/types";
import { Box } from "../../../../../ui";

const query = { feed: "latest", limit: 200 } as const;
let setup: Awaited<ReturnType<typeof testRender>>;
let service: NewsService;
function story(id = "acme", title = "Acme plans acquisition", version = 1, items = false): NewsArticle {
  const publishedAt = new Date(`2026-09-11T1${version}:00:00Z`);
  return {
    id, title, publishedAt,
    url: `https://example.test/${id}`,
    source: "Controlled wire",
    summary: `Acme cash consideration version ${version}`,
    topic: "earnings", topics: ["earnings"], sectors: [], categories: [], tickers: [],
    scores: { importance: 70, urgency: 0, marketImpact: 70, novelty: 0, confidence: 90 },
    importance: 70, isBreaking: false, isDeveloping: true,
    ...(items ? { items: [{
      id: `${id}-update-${version}`,
      title: `Timeline cash consideration ${version}`,
      summary: `Verified transaction detail ${version}`,
      publishedAt,
      url: `https://example.test/${id}/${version}`,
      sourceName: "Controlled wire", sourceKey: "controlled",
    }] } : {}),
  };
}

async function mount(
  fetchNews: () => Promise<NewsArticle[]>,
  fetchNewsStory: (id: string) => Promise<NewsArticle | null>,
  fallback?: (id: string) => Promise<NewsArticle | null>,
  paneState: Record<string, unknown> = {},
) {
  service = new NewsService();
  service.register(newsProvider({
    id: "wire", name: "Controlled wire", priority: 1,
    provider: { fetchNews, fetchNewsStory },
  }));
  if (fallback) service.register(newsProvider({
    id: "fallback", name: "Fallback wire", priority: 2,
    provider: { fetchNews: async () => [], fetchNewsStory: fallback },
  }));
  setSharedNewsService(service);
  const config = createTestPaneConfig("/tmp/news-controlled-unused", { instanceId: "news-feed", paneId: "news-feed" });
  const initial = createInitialState(config);
  initial.focusedPaneId = "news-feed";
  if (Object.keys(paneState).length > 0) initial.paneState = { "news-feed": { pluginState: { news: paneState } } };
  const runtime = createStatefulTestPluginRuntime();
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId="news-feed" pluginId="news" runtime={runtime}>
        <PaneFooterProvider>{(footer) => (
          <Box width={100} height={26} flexDirection="column">
            <Box height={25}>
              <NewsPresetPane
                focused width={100} height={25} paneKey="feed" title="News"
                query={query} columns={["time", "source", "title"]}
                defaultSort={{ columnId: "time", direction: "desc" }}
                emptyStateTitle="No news" emptyStateHint=""
              />
            </Box>
            <PaneFooterBar footer={footer} focused width={100} />
          </Box>
        )}</PaneFooterProvider>
      </TestPaneProvider>
    );
  }
  await act(async () => { setup = await testRender(<Harness />, { width: 100, height: 26 }); });
  await settleFrame(setup, 12);
}

async function key(name: string) {
  await emitKeypress(setup, { name });
  await settleFrame(setup, 10);
}

async function refresh() {
  await act(async () => { await service.load(query); });
  await settleFrame(setup, 12);
}

function capture() { return setup.captureCharFrame(); }

afterEach(async () => {
  if (setup) await act(async () => setup.renderer.destroy());
  service?.stop();
  setSharedNewsService(null);
});

test("reopening a temporarily unavailable story retries detail", async () => {
  let calls = 0;
  await mount(async () => [story()], async () => ++calls === 1 ? null : story("acme", "Acme plans acquisition", 1, true));
  expect(capture()).toContain("Acme plans acquisition");
  await key("return");
  expect(calls).toBe(1);
  await key("escape");
  await key("return");
  const frame = capture();
  expect(calls).toBe(2);
  expect(frame).toContain("Timeline cash consideration 1");
});

test("a restored or shared pane opens on its story even when the feed no longer lists it", async () => {
  const requested: string[] = [];
  await mount(
    async () => [story("other", "Unrelated issuer deal")],
    async (id) => { requested.push(id); return id === "acme" ? story("acme", "Acme plans acquisition", 1, true) : null; },
    undefined,
    { "feed:openArticleId": "acme" },
  );
  const frame = capture();
  expect(requested).toEqual(["acme"]);
  expect(frame).toContain("Acme plans acquisition");
  expect(frame).toContain("Timeline cash consideration 1");
  await key("escape");
  expect(capture()).toContain("Unrelated issuer deal");
  expect(capture()).not.toContain("Acme plans acquisition");
});

test("a story id nobody can explain is dropped rather than left loading", async () => {
  await mount(async () => [story()], async () => null, undefined, { "feed:openArticleId": "vanished" });
  const frame = capture();
  expect(frame).toContain("Acme plans acquisition");
  expect(frame).not.toContain("loading");
});

test("detail source must return the selected story identity", async () => {
  let primary = 0, fallback = 0;
  await mount(async () => [story()], async () => { primary++; return story("other", "Unrelated issuer deal", 1, true); }, async () => { fallback++; return story("acme", "Acme plans acquisition", 1, true); });
  await key("return");
  const frame = capture();
  expect(frame).not.toContain("Unrelated issuer deal");
  expect(primary).toBe(1);
  expect(fallback).toBe(1);
});

test("an updated feed must replace earlier open story content", async () => {
  let version = 1, calls = 0;
  await mount(async () => [story("acme", version === 1 ? "Acme plans acquisition" : "Acme acquisition terminated", version)], async () => { calls++; return story("acme", version === 1 ? "Acme plans acquisition" : "Acme acquisition terminated", version, true); });
  await key("return");
  expect(capture()).toContain("Timeline cash consideration 1");
  version = 2;
  await refresh();
  const frame = capture();
  expect(frame).toContain("Acme acquisition terminated");
  expect(frame).toContain("Timeline cash consideration 2");
  await key("escape");
  expect(capture()).toContain("Acme acquisition terminated");
  await key("return");
  const reopened = capture();
  expect(reopened).toContain("Acme acquisition terminated");
});

test("unchanged feed refresh retains loaded timeline without repeated requests", async () => {
  let calls = 0;
  await mount(async () => [story()], async () => { calls++; return story("acme", "Acme plans acquisition", 1, true); });
  await key("return");
  for (let n = 0; n < 3; n++) await refresh();
  expect(capture()).toContain("Timeline cash consideration 1");
  expect(calls).toBe(1);
});

test("late earlier detail cannot overwrite a refreshed story", async () => {
  let version = 1, calls = 0;
  let resolveOld!: (article: NewsArticle) => void;
  await mount(async () => [story("acme", version === 1 ? "Acme plans acquisition" : "Acme acquisition terminated", version)], async () => { calls++; if (calls === 1) return new Promise<NewsArticle>((resolve) => { resolveOld = resolve; }); return story("acme", "Acme acquisition terminated", 2, true); });
  await key("return");
  expect(calls).toBe(1);
  version = 2;
  await refresh();
  expect(capture()).toContain("Timeline cash consideration 2");
  await act(async () => resolveOld(story("acme", "Acme plans acquisition", 1, true)));
  await settleFrame(setup, 12);
  const frame = capture();
  expect(frame).toContain("Acme acquisition terminated");
  expect(frame).not.toContain("Timeline cash consideration 1");
  expect(service.getQueryState(query).articles[0]?.title).toBe("Acme acquisition terminated");
});

test("source failure uses footer and reopening recovers without repeated automatic retries", async () => {
  let calls = 0;
  await mount(async () => [story()], async () => { calls++; if (calls === 1) throw new Error("Controlled source 503"); return story("acme", "Acme plans acquisition", 1, true); });
  await key("return");
  const failed = capture();
  expect(failed).toContain("Story detail unavailable");
  expect(failed).toContain("Acme cash consideration version 1");
  await settleFrame(setup, 20);
  expect(calls).toBe(1);
  await key("escape");
  await key("return");
  const recovered = capture();
  expect(recovered).toContain("Timeline cash consideration 1");
  expect(recovered).not.toContain("Story detail unavailable");
  expect(calls).toBe(2);
});

test("same-time headline correction invalidates loaded old detail", async () => {
  let corrected = false, calls = 0;
  const title = () => corrected ? "Acme cash offer corrected" : "Acme plans acquisition";
  await mount(async () => [story("acme", title())], async () => { calls++; return story("acme", title(), 1, true); });
  await key("return");
  corrected = true;
  await refresh();
  expect(capture()).toContain("Acme cash offer corrected");
  expect(calls).toBe(2);
});


test("a corrected URL leaves one selectable row for the stable story ID", async () => {
  let corrected = false;
  const article = () => corrected
    ? { ...story(), title: "Acme corrected publication link", url: "https://example.test/acme-corrected" }
    : story();
  await mount(async () => [article()], async () => ({ ...article(), items: story("acme", "", 1, true).items }));
  corrected = true;
  await refresh();
  expect(service.getQueryState(query).articles).toHaveLength(1);
  expect(capture()).toContain("Acme corrected publication link");
  expect(capture()).not.toContain("Acme plans acquisition");
  await key("return");
  expect(capture()).toContain("Acme corrected publication link");
});

test("a timeline correction supersedes an earlier pending detail", async () => {
  let corrected = false;
  let resolveOld!: (article: NewsArticle) => void;
  const updated = story("acme", "Acme plans acquisition", 1, true);
  updated.items![0] = { ...updated.items![0]!, title: "Corrected cash consideration $12" };
  await mount(async () => [corrected ? updated : story()], async () => new Promise<NewsArticle>((resolve) => { resolveOld = resolve; }));
  await key("return");
  corrected = true;
  await refresh();
  expect(capture()).toContain("Corrected cash consideration $12");
  await act(async () => { resolveOld(story("acme", "Acme plans acquisition", 1, true)); });
  await settleFrame(setup, 12);
  expect(capture()).toContain("Corrected cash consideration $12");
  expect(capture()).not.toContain("Timeline cash consideration 1");
});

test("older detail preserves the newer known headline and summary", async () => {
  await mount(
    async () => [story("acme", "Acme acquisition terminated", 2)],
    async () => story("acme", "Acme plans acquisition", 1, true),
  );
  await key("return");
  expect(capture()).toContain("Acme acquisition terminated");
  expect(capture()).toContain("Acme cash consideration version 2");
  expect(capture()).toContain("Timeline cash consideration 1");
  const updatedLine = capture().split("\n").find((line) => line.includes("Last updated"));
  expect(updatedLine).toContain(formatDetailDate(new Date("2026-09-11T12:00:00Z")));
  expect(capture()).toContain(formatDetailDate(new Date("2026-09-11T11:00:00Z")));
  expect(service.getQueryState(query).articles[0]?.title).toBe("Acme acquisition terminated");
});

test("a newer detail fallback is preferred to an older primary response", async () => {
  let fallback = 0;
  await mount(
    async () => [story("acme", "Acme acquisition terminated", 2)],
    async () => story("acme", "Acme plans acquisition", 1, true),
    async () => { fallback++; return story("acme", "Acme acquisition terminated", 2, true); },
  );
  await key("return");
  expect(fallback).toBe(1);
  expect(capture()).toContain("Timeline cash consideration 2");
  expect(capture()).not.toContain("Timeline cash consideration 1");
});
