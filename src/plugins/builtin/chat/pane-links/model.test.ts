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
    // What the composer sends with a link chip: the text, a blank line, the link.
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
    const calendar = { kind: "economic-calendar", date: "2026-10-09" } as const;
    expect(chatMessagePaneLinks({ content: "Macro calendar\nhttps://example.com/page", paneLink: calendar })).toEqual({
      links: [{ kind: "wire", link: calendar }],
      content: "Macro calendar\nhttps://example.com/page",
    });
    expect(chatMessagePaneLinks({ content, paneLink: calendar }).links.map((entry) => entry.kind)).toEqual(["share", "wire"]);
  });

  test("a news post that still ends in the publisher's address drops that line and keeps its story chip", () => {
    const paneLink = { kind: "news-story", storyId: "story-1" } as const;
    const legacy = "Sample Corp expands packaging deal (Example Wire, Oct 9) $SAMPL $EXMPL";
    expect(chatMessagePaneLinks({ content: `${legacy}\nhttps://news.example.com/story/packaging?id=1`, paneLink })).toEqual({
      links: [{ kind: "wire", link: paneLink }],
      content: legacy,
    });
    // Cut off at the message limit, the address is still the last line.
    expect(chatMessagePaneLinks({ content: `${legacy}\nhttps://news.example.com/story/pack…`, paneLink }).content).toBe(legacy);
    // The text a post is made of today has no such line and is left as it is.
    expect(chatMessagePaneLinks({ content: legacy, paneLink }).content).toBe(legacy);
  });

  test("only a last line that is nothing but an address goes", () => {
    const paneLink = { kind: "news-story", storyId: "story-1" } as const;
    for (const content of [
      "see https://news.example.com/a for the story",
      "Headline\nhttps://news.example.com/a\nmore words",
      "Headline\nread it at https://news.example.com/a",
      "https://news.example.com/a",
    ]) {
      expect(chatMessagePaneLinks({ content, paneLink }).content).toBe(content);
    }
  });

  test("a message with no story link keeps a trailing address, whatever it looks like", () => {
    const content = "Sample Corp expands packaging deal (Example Wire, Oct 9) $SAMPL\nhttps://news.example.com/story/packaging";
    expect(chatMessagePaneLinks({ content })).toEqual({ links: [], content });
    // Another kind of Wire post is not a news post.
    expect(chatMessagePaneLinks({ content, paneLink: { kind: "ipo-calendar", date: "2026-10-09" } }).content).toBe(content);
  });
});
