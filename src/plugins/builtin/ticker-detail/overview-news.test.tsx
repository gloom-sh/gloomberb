import { afterEach, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, PaneInstanceProvider, type AppState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PaneTemplateCreateOptions, TickerResearchTabDef } from "../../../types/plugin";
import type { TickerFinancials } from "../../../types/financials";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestPaneConfig } from "../../../test-support/pane";
import { createTestArticle } from "../../../test-support/news";
import { NewsService } from "../../../news/aggregator";
import { setSharedNewsService } from "../../../news/hooks";
import type { NewsArticle } from "../../../news/types";
import { newsProvider } from "../../../capabilities";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { PluginRenderProvider } from "../../runtime";
import { withPluginStateNamespace } from "../../runtime/context";
import { tickerNewsModule } from "../news";
import { TICKER_RESEARCH_BUILTIN_TABS } from "./research-tabs";
import { tickerDetailModule } from ".";

const PANE_ID = "ticker-research:news";
const WIDTH = 110;
const HEIGHT = 44;
/** Past the pane's 120ms commit of a tab change. */
const COMMIT_MS = 160;
const tui = createOpenTuiTestHarness();
let service: NewsService | null = null;
let paneState: AppState["paneState"][string] = {};
let opened: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];

const runtime = createStatefulTestPluginRuntime({
  createPaneFromTemplate: (templateId, options) => { opened.push({ templateId, options }); },
});

const DetailPane = tickerDetailModule.panes![0]!.component as (props: {
  paneId: string; paneType: string; focused: boolean; width: number; height: number;
}) => ReactElement;

/** The News view as the news plugin registers it, in its own state namespace as the registry draws it. */
function newsTab(): TickerResearchTabDef {
  let registered: TickerResearchTabDef | null = null;
  tickerNewsModule.setup!({ registerTickerResearchTab: (tab: TickerResearchTabDef) => { registered = tab; } } as never);
  const tab = registered as unknown as TickerResearchTabDef;
  return { ...tab, component: withPluginStateNamespace("news", tab.component) };
}

const financialsTab: TickerResearchTabDef = { id: "financials", name: "Financials", order: 20, component: () => <text>body:financials</text> };

const at = (hour: number) => new Date(Date.UTC(2026, 9, 12, hour, 0));
const STORIES = [
  createTestArticle("oldest", { title: "Oldest Apple story", source: "Wire One", publishedAt: at(8) }),
  createTestArticle("newest", { title: "Apple unveils a new chip", source: "Wire Two", publishedAt: at(13), summary: "The chip summary." }),
  createTestArticle("older", { title: "Older Apple story", source: "Wire One", publishedAt: at(9) }),
  createTestArticle("second", { title: "Apple supplier raises guidance", source: "Wire Three", publishedAt: at(12) }),
  createTestArticle("third", { title: "Analysts weigh Apple services", source: "Wire One", publishedAt: at(11) }),
];

const FINANCIALS: TickerFinancials = {
  quote: { symbol: "AAPL", price: 230, change: 1, changePercent: 0.44, currency: "USD", lastUpdated: at(13).getTime() },
  fundamentals: { trailingPE: 31.2, marketCap: 3.4e12 },
  annualStatements: [{ date: "2025-09-27", totalRevenue: 391e9, netIncome: 94e9 }],
  quarterlyStatements: [],
  priceHistory: [],
};

/** A story's detail, with the coverage a story carries. */
function storyDetail(id: string): NewsArticle | null {
  const story = STORIES.find((entry) => entry.id === id);
  return story ? {
    ...story,
    items: [{ id: `${id}:coverage`, title: `${story.title} (coverage)`, publishedAt: story.publishedAt, url: story.url, sourceName: story.source, sourceKey: "wire" }],
  } : null;
}

function mountNews(fetchNews: () => Promise<NewsArticle[]>): void {
  service = new NewsService();
  service.register(newsProvider({
    id: "wire", name: "Controlled wire", priority: 1,
    provider: { fetchNews, fetchNewsStory: async (id) => storyDetail(id) },
  }));
  setSharedNewsService(service);
}

function Harness({ settings }: { settings?: Record<string, unknown> }) {
  const config = createTestPaneConfig("/tmp/gloomberb-overview-news-unused", {
    instanceId: PANE_ID,
    paneId: TICKER_RESEARCH_PANE_ID,
    binding: { kind: "fixed", symbol: "AAPL" },
    ...(settings ? { settings } : {}),
  });
  const initial = createInitialState(config);
  initial.focusedPaneId = PANE_ID;
  initial.tickers = new Map([["AAPL", createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ", currency: "USD" })]]);
  initial.financials = new Map([["AAPL", FINANCIALS]]);
  const [app, dispatch] = useReducer(appReducer, initial);
  paneState = app.paneState[PANE_ID] ?? {};
  return (
    <AppContext value={createStaticAppStore(app, dispatch)}>
      <PaneInstanceProvider paneId={PANE_ID}>
        <PluginRenderProvider pluginId="ticker-research" runtime={runtime}>
          <DetailPane paneId={PANE_ID} paneType={TICKER_RESEARCH_PANE_ID} focused width={WIDTH} height={HEIGHT} />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function render(settings?: Record<string, unknown>): Promise<string> {
  setSharedRegistryForTests({
    tickerResearchTabs: new Map([TICKER_RESEARCH_BUILTIN_TABS[0]!, financialsTab, newsTab()].map((tab) => [tab.id, tab])),
  } as unknown as PluginRegistry);
  await act(async () => { await tui.render(<Harness settings={settings} />, { width: WIDTH, height: HEIGHT }); });
  await settleFrame(tui.setup(), 12);
  return tui.frame();
}

async function click(text: string): Promise<string> {
  await act(async () => {
    await tui.clickFrameText(text);
    await new Promise((resolve) => setTimeout(resolve, COMMIT_MS));
  });
  await settleFrame(tui.setup(), 12);
  return tui.frame();
}

afterEach(() => {
  service?.stop();
  service = null;
  setSharedNewsService(null);
  setSharedRegistryForTests(undefined);
  opened = [];
  paneState = {};
});

test("the overview's news stays out of the way until the company has stories, then lists the three newest", async () => {
  const { promise, resolve } = Promise.withResolvers<NewsArticle[]>();
  mountNews(() => promise);
  // Loading: no heading or rows standing empty.
  let frame = await render();
  expect(frame).toContain("Fundamentals");
  expect(frame).not.toMatch(/^\s*News\s*$/m);
  expect(frame).not.toContain("Open News");

  await act(async () => { resolve(STORIES); await promise; });
  await settleFrame(tui.setup(), 12);
  frame = tui.frame();
  const lines = frame.split("\n");
  const heading = lines.findIndex((line) => /^\s*News\s*$/.test(line));
  expect(heading).toBeGreaterThan(lines.findIndex((line) => line.includes("Fundamentals")));
  // Newest first, each with its source; the two oldest wait in the News view.
  expect(lines[heading + 1]).toMatch(/Wire Two\s+Apple unveils a new chip/);
  expect(lines[heading + 2]).toMatch(/Wire Three\s+Apple supplier raises guidance/);
  expect(lines[heading + 3]).toMatch(/Wire One\s+Analysts weigh Apple services/);
  expect(lines[heading + 4]).toContain("Open News");
  expect(frame).not.toContain("Older Apple story");
  expect(frame).not.toContain("Oldest Apple story");
});

test("a company with no stories has no news section", async () => {
  mountNews(async () => []);
  const frame = await render();
  expect(frame).toContain("Fundamentals");
  expect(frame).not.toMatch(/^\s*News\s*$/m);
  expect(frame).not.toContain("Open News");
});

test("a headline opens its story in the pane's News view, and the overview's links open News and Financials there", async () => {
  mountNews(async () => STORIES);
  await render();
  let frame = await click("Apple unveils a new chip");
  // Buzz's News view, on the story; Back lands on its row.
  expect(paneState.activeTabId).toBe("news");
  expect(frame.split("\n")[0]).toContain("Buzz");
  expect(frame).toContain("The chip summary.");
  expect(paneState.pluginState?.news?.["openArticleId:AAPL"]).toBe("newest");
  expect(opened).toEqual([]);

  // Back lands on the story's row in the News view's list.
  await tui.emitKeypress({ name: "escape" });
  await settleFrame(tui.setup(), 12);
  frame = tui.frame();
  expect(frame).not.toContain("The chip summary.");
  expect(frame).toMatch(/Wire Two\s+Apple unveils a new chip/);
  expect(paneState.pluginState?.news?.["selectedArticleId:AAPL"]).toBe("newest");

  frame = await click("Overview");
  frame = await click("Open Financials");
  expect(paneState.activeTabId).toBe("financials");
  expect(frame).toContain("body:financials");

  await click("Overview");
  await click("Open News");
  expect(paneState.activeTabId).toBe("news");
  expect(opened).toEqual([]);
});

test("a pane locked to Overview opens a story and the news in panes of their own", async () => {
  mountNews(async () => STORIES);
  await render({ hideTabs: true, lockedTabId: "overview" });
  await click("Apple supplier raises guidance");
  expect(opened).toEqual([{ templateId: "news-story-pane", options: { arg: "second", values: { title: "Apple supplier raises guidance" } } }]);
  // The News view of this pane is never shown, so it is not left holding the story.
  expect(paneState.pluginState?.news?.["openArticleId:AAPL"]).toBeUndefined();

  await click("Open News");
  expect(opened[1]?.templateId).toBe("ticker-news-pane");
  expect(opened[1]?.options?.symbol).toBe("AAPL");
});
