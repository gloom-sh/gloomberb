import { TextAttributes } from "@opentui/core";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../../../ui";
import { testRender } from "../../../../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  createInitialState,
} from "../../../../../state/app/context";
import { createDefaultConfig } from "../../../../../types/config";
import type { MarketNewsItem } from "../../../../../types/news-source";
import { NewsArticleStackView, type NewsSortPreference } from "./table";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

const sortPreference: NewsSortPreference = {
  columnId: "time",
  direction: "desc",
};

function makeArticle(overrides: Partial<MarketNewsItem> & { id: string; title: string }): MarketNewsItem {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: "Reuters",
    publishedAt: new Date("2026-04-18T12:00:00Z"),
    summary: "",
    topic: "general",
    topics: [],
    sectors: [],
    categories: [],
    tickers: [],
    scores: {
      importance: 0,
      urgency: 0,
      marketImpact: 0,
      novelty: 0,
      confidence: 0,
    },
    isBreaking: false,
    isDeveloping: false,
    importance: 0,
    ...rest,
  };
}

function Harness() {
  const state = createInitialState(
    createDefaultConfig("/tmp/gloomberb-news-table-test"),
  );

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId="news-feed:main">
        <NewsArticleStackView
          articles={[
            makeArticle({ id: "unread", title: "Unread story" }),
            makeArticle({ id: "read", title: "Read story" }),
          ]}
          focused
          width={90}
          rootHeight={10}
          readArticleIds={new Set(["read"])}
          selectedArticleId="unread"
          setSelectedArticleId={() => {}}
          sortPreference={sortPreference}
          setSortPreference={() => {}}
          onOpenArticle={() => {}}
          detailOpen={false}
          onBack={() => {}}
          detailContent={<Box />}
          columns={["time", "source", "title"]}
          emptyStateTitle="No stories"
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
});

describe("NewsArticleStackView", () => {
  test("renders unopened stories bold and opened stories normal weight", async () => {
    testSetup = await testRender(<Harness />, { width: 90, height: 10 });

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const boldText = testSetup.captureSpans().lines
      .flatMap((line) => line.spans)
      .filter((span) => (span.attributes & TextAttributes.BOLD) !== 0)
      .map((span) => span.text)
      .join("");

    expect(boldText).toContain("Unread story");
    expect(boldText).not.toContain("Read story");
  });

  test("keeps the last column and human labels inside the pane width", async () => {
    const state = createInitialState(
      createDefaultConfig("/tmp/gloomberb-news-table-layout-test"),
    );

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="news-top:main">
          <NewsArticleStackView
            articles={[
              makeArticle({
                id: "macro",
                title: "Fed officials signal caution on further rate cuts as inflation stays sticky",
                source: "globenewswire-releases",
                categories: ["macro_politics"],
                importance: 87,
              }),
            ]}
            focused
            width={90}
            rootHeight={10}
            selectedArticleId="macro"
            setSelectedArticleId={() => {}}
            sortPreference={{ columnId: "importance", direction: "desc" }}
            setSortPreference={() => {}}
            onOpenArticle={() => {}}
            detailOpen={false}
            onBack={() => {}}
            detailContent={<Box />}
            columns={["time", "source", "title", "tickers", "categories", "importance"]}
            emptyStateTitle="No stories"
          />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 90, height: 10 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const lines = testSetup.captureCharFrame().split("\n");
    // The sorted column and its indicator must survive the layout arithmetic.
    expect(lines[0]).toContain("SCORE");
    expect(lines[0]).toContain("\u25bc");
    expect(lines[0]!.length).toBeLessThanOrEqual(90);
    expect(lines[1]).toContain("87");
    // Snake_case ids and mid-word clipping never reach the user.
    expect(lines[1]).toContain("Politics");
    expect(lines[1]).not.toContain("macro_politics");
    expect(lines[1]).toContain("globenews...");
  });

  test("dedupes exchange-qualified ticker aliases in table cells", async () => {
    const state = createInitialState(
      createDefaultConfig("/tmp/gloomberb-news-table-ticker-dedupe-test"),
    );

    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="news-feed:main">
          <NewsArticleStackView
            articles={[
              makeArticle({
                id: "media",
                title: "Media merger story",
                tickers: ["NFLX", "NFLX:XNAS", "PARA", "PARA:XNAS"],
              }),
            ]}
            focused
            width={90}
            rootHeight={10}
            selectedArticleId="media"
            setSelectedArticleId={() => {}}
            sortPreference={sortPreference}
            setSortPreference={() => {}}
            onOpenArticle={() => {}}
            detailOpen={false}
            onBack={() => {}}
            detailContent={<Box />}
            columns={["time", "source", "title", "tickers"]}
            emptyStateTitle="No stories"
          />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 90, height: 10 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("NFLX");
    expect(frame).toContain("PARA");
    expect(frame).not.toContain("NFLX:XNAS");
    expect(frame).not.toContain("PARA:XNAS");
  });
});
