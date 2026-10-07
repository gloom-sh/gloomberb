import { TextAttributes } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../../../ui";
import { createOpenTuiTestHarness } from "../../../../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  createInitialState,
} from "../../../../../state/app/context";
import { createStaticAppStore } from "../../../../../test-support/app-store";
import { createDefaultConfig } from "../../../../../types/config";
import type { MarketNewsItem } from "../../../../../types/news-source";
import { createTestArticle } from "../../../../../test-support/news";
import { NewsArticleStackView, buildColumns, type NewsSortPreference } from "./table";

const tui = createOpenTuiTestHarness();

const sortPreference: NewsSortPreference = {
  columnId: "time",
  direction: "desc",
};

function makeArticle({ id, ...overrides }: Partial<MarketNewsItem> & { id: string; title: string }): MarketNewsItem {
  return createTestArticle(id, {
    source: "Reuters",
    publishedAt: new Date("2026-04-18T12:00:00Z"),
    summary: "",
    topics: [],
    scores: { importance: 0, urgency: 0, marketImpact: 0, novelty: 0, confidence: 0 },
    importance: 0,
    ...overrides,
  });
}

function Harness() {
  const state = createInitialState(
    createDefaultConfig("/tmp/gloomberb-news-table-test"),
  );

  return (
    <AppContext value={createStaticAppStore(state)}>
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

describe("NewsArticleStackView", () => {
  test("renders unopened stories bold and opened stories normal weight", async () => {
    await tui.render(<Harness />, { width: 90, height: 10 });

    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const boldText = tui.setup().captureSpans().lines
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

    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
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
            width={94}
            rootHeight={10}
            selectedArticleId="macro"
            setSelectedArticleId={() => {}}
            sortPreference={{ columnId: "importance", direction: "desc" }}
            setSortPreference={() => {}}
            onOpenArticle={() => {}}
            detailOpen={false}
            onBack={() => {}}
            detailContent={<Box />}
            columns={["time", "title", "tickers", "categories", "importance"]}
            emptyStateTitle="No stories"
          />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 94, height: 10 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const lines = tui.frame().split("\n");
    // The sorted column and its indicator must survive the layout arithmetic.
    expect(lines[0]).toContain("SCORE");
    expect(lines[0]).toContain("\u25bc");
    expect(lines[0]!.length).toBeLessThanOrEqual(94);
    expect(lines[1]).toContain("87");
    // Snake_case ids and mid-word clipping never reach the user.
    expect(lines[1]).toContain("Politics");
    expect(lines[1]).not.toContain("macro_politics");
    // The headline takes every cell the fixed columns leave, clipped behind one mark.
    expect(lines[1]).toContain("Fed officials signal caution on further r\u2026");
  });

  test("narrowing gives up category, then ticker room, before the headline", () => {
    const ids = (width: number) => buildColumns(width, ["time", "source", "title", "tickers", "categories", "importance"])
      .map((column) => column.id === "tickers" ? `tickers:${column.width}` : column.id);
    expect(ids(127)).toEqual(["time", "source", "title", "tickers:18", "categories", "importance"]);
    expect(ids(102)).toEqual(["time", "source", "title", "tickers:18", "importance"]);
    expect(ids(92)).toEqual(["time", "source", "title", "tickers:10", "importance"]);
    expect(ids(79)).toEqual(["time", "title", "tickers:10", "importance"]);
    expect(ids(64)).toEqual(["time", "title", "importance"]);
    expect(ids(49)).toEqual(["time", "title"]);
  });

  test("dedupes exchange-qualified ticker aliases in table cells", async () => {
    const state = createInitialState(
      createDefaultConfig("/tmp/gloomberb-news-table-ticker-dedupe-test"),
    );

    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
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
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("NFLX");
    expect(frame).toContain("PARA");
    expect(frame).not.toContain("NFLX:XNAS");
    expect(frame).not.toContain("PARA:XNAS");
  });
});
