import { describe, expect, test } from "bun:test";
import { composerMessage, joinComposerDraft, splitComposerDraft, takePastedShareLinks, type ComposerShareLink } from "./composer";
import { chatMessagePaneLinks } from "./model";

const link = (digit: string): ComposerShareLink => {
  const id = digit.repeat(32);
  return { kind: "share", id, url: `https://term.gloom.sh/api/shares/${id}/open` };
};

describe("composer share links", () => {
  test("a saved draft reads back as the same text and chips, whatever the text ends in", () => {
    // The field's text comes back exactly, or typing would jump while the draft saves.
    const texts = ["", "Chain for the week", "trailing space ", "trailing line\n", "two lines\n\n", " ", "see https://gloom.sh/docs here"];
    for (const text of texts) {
      for (const links of [[], [link("1")], [link("1"), link("2")]]) {
        expect(splitComposerDraft(joinComposerDraft(text, links))).toEqual({ text, links });
      }
    }
  });

  test("only links at the end of a draft, each after a blank line, are chips; one in the text stays text", () => {
    expect(splitComposerDraft(`Look\n\n${link("1").url}`)).toEqual({ text: "Look", links: [link("1")] });
    expect(splitComposerDraft(link("1").url)).toEqual({ text: "", links: [link("1")] });
    const inline = `see ${link("1").url} for the chain`;
    expect(splitComposerDraft(inline)).toEqual({ text: inline, links: [] });
    expect(splitComposerDraft(`Look\n${link("1").url}`)).toEqual({ text: `Look\n${link("1").url}`, links: [] });
    // As many as a message draws; an earlier one stays text.
    const four = ["1", "2", "3", "4"].map(link);
    expect(splitComposerDraft(four.map((entry) => entry.url).join("\n\n"))).toEqual({ text: four[0]!.url, links: four.slice(1) });
  });

  test("the message sent is the text, a blank line, then each link, and reads back as chips", () => {
    const content = composerMessage("  Chain for the week \n", [link("1")]);
    expect(content).toBe(`Chain for the week\n\n${link("1").url}`);
    expect(chatMessagePaneLinks({ content })).toEqual({ links: [link("1")], content: "Chain for the week" });
    expect(composerMessage("   ", [link("1")])).toBe(link("1").url);
    expect(composerMessage(" plain ", [])).toBe("plain");
  });

  test("a paste gives up its share links once each, up to a message's chips, and keeps everything else", () => {
    const pasted = `look ${link("1").url} and https://gloom.sh/docs\n${link("1").url}`;
    expect(takePastedShareLinks(pasted, [])).toEqual({ text: "look and https://gloom.sh/docs", links: [link("1")] });
    // A share that already has a chip leaves the paste without adding another.
    expect(takePastedShareLinks(link("1").url, [link("1")])).toEqual({ text: "", links: [] });
    expect(takePastedShareLinks(`${link("3").url} ${link("4").url}`, [link("1"), link("2")]))
      .toEqual({ text: link("4").url, links: [link("3")] });
    expect(takePastedShareLinks("https://gloom.sh/docs and words", [])).toBeNull();
    expect(takePastedShareLinks(`https://term.gloom.sh.example.com/s/${"1".repeat(32)}`, [])).toBeNull();
  });
});
