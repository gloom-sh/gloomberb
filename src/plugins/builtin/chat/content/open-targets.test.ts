import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../../../api-client";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { chatMessagePaneLinks } from "../pane-links/model";
import { chatMessageOpenTargets } from "./open-targets";

const catalog: Record<string, InlineTickerCatalogEntry> = {
  SAMPL: { status: "ready", ticker: null, quote: null },
};
const ARTICLE = "https://news.example.com/story/packaging";
const HEADLINE = "Sample Corp expands packaging deal (Example Wire, Oct 9) $SAMPL $GONE";

/** What the footer's Open list offers for a message: the targets of what its row draws. */
function targetsOf(message: Pick<ChatMessage, "content" | "paneLink">): string[] {
  const { links, content } = chatMessagePaneLinks(message);
  return chatMessageOpenTargets(content, catalog, [], links).map((target) => {
    if (target.kind === "pane") return `pane:${target.link.kind === "wire" ? target.link.link.kind : "share"}`;
    if (target.kind === "ticker") return `ticker:${target.symbol}`;
    return target.kind === "link" ? `link:${target.url}` : target.kind;
  });
}

describe("chatMessageOpenTargets", () => {
  test("a news post that still ends in the publisher's address opens its story and its tickers, never the address", () => {
    expect(targetsOf({ content: `${HEADLINE}\n${ARTICLE}`, paneLink: { kind: "news-story", storyId: "story-1" } }))
      .toEqual(["pane:news-story", "ticker:SAMPL"]);
  });

  test("a post as the Wire writes it now offers the same targets", () => {
    expect(targetsOf({ content: HEADLINE, paneLink: { kind: "news-story", storyId: "story-1" } }))
      .toEqual(["pane:news-story", "ticker:SAMPL"]);
  });

  test("a message with no story link keeps its address as a target, however much it reads like a news post", () => {
    expect(targetsOf({ content: `${HEADLINE}\n${ARTICLE}` })).toEqual(["ticker:SAMPL", `link:${ARTICLE}`]);
    expect(targetsOf({ content: `${HEADLINE}\n${ARTICLE}`, paneLink: { kind: "economic-calendar", date: "2026-10-09" } }))
      .toEqual(["pane:economic-calendar", "ticker:SAMPL", `link:${ARTICLE}`]);
  });
});
