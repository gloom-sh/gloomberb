import { describe, expect, test } from "bun:test";
import { chatMessagePaneLinks } from "./model";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const link = (id: string) => `https://term.gloom.sh/api/shares/${id}/open`;

describe("chatMessagePaneLinks", () => {
  test("leaves a message without share links exactly as written", () => {
    const content = "see https://gloom.sh/docs and  $NVDA\n\n\nbye ";
    expect(chatMessagePaneLinks({ content })).toEqual({ links: [], content });
  });

  test("takes the share links its chips stand for out of the text, and the gaps they leave", () => {
    // What Share > Post to chat sends: the caption, a blank line, the link.
    expect(chatMessagePaneLinks({ content: `Chain for the week\n\n${link(ID)}` })).toEqual({
      links: [{ kind: "share", id: ID, url: link(ID) }],
      content: "Chain for the week",
    });
    expect(chatMessagePaneLinks({ content: link(ID) }).content).toBe("");
    expect(chatMessagePaneLinks({ content: `before\n\n${link(ID)}\n\nafter\n\n\nend` }).content).toBe("before\n\nafter\n\n\nend");
    expect(chatMessagePaneLinks({ content: `look at ${link(ID)} for the chain, then https://example.com` }).content)
      .toBe("look at for the chain, then https://example.com");
  });

  test("one chip per share, the same share twice included, and at most three", () => {
    const ids = ["1", "2", "3", "4"].map((digit) => digit.repeat(32));
    const { links, content } = chatMessagePaneLinks({
      content: `${link(ID)} again https://term.gloom.sh/s/${ID}\n${ids.map(link).join("\n")}`,
    });
    expect(links.map((entry) => (entry.kind === "share" ? entry.id : null))).toEqual([ID, ids[0]!, ids[1]!]);
    // Past three, a share stays the link it was.
    expect(content).toBe(`again\n${link(ids[2]!)}\n${link(ids[3]!)}`);
  });

  test("a Wire post keeps its text whole and gets the chip its field names", () => {
    const content = `Headline (Publisher, Oct 9) $NVDA\n${link(OTHER)}`;
    const result = chatMessagePaneLinks({ content: "Headline\nhttps://example.com/story", paneLink: { kind: "news-story", storyId: "story-1" } });
    expect(result).toEqual({
      links: [{ kind: "wire", link: { kind: "news-story", storyId: "story-1" } }],
      content: "Headline\nhttps://example.com/story",
    });
    expect(chatMessagePaneLinks({ content, paneLink: { kind: "economic-calendar", date: "2026-10-09" } }).links.map((entry) => entry.kind))
      .toEqual(["share", "wire"]);
  });
});
