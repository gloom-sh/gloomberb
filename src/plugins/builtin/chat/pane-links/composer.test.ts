import { describe, expect, test } from "bun:test";
import { composerMessage, composerViewOfDraft, joinComposerDraft, pastedShareChips, splitComposerDraft, type ComposerShareLink } from "./composer";
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

  test("the composer's own draft coming back keeps its view, even text that ends in a share link", () => {
    // Typed, pasted over a selection, or a terminal paste with no paste markers: the
    // link stays text where it was put, and a snapshot must not pull it into a chip.
    const texts = ["", "Chain for the week", "trailing line\n", link("3").url, `Look\n\n${link("3").url}`, `${link("3").url}\n\n${link("4").url}`];
    for (const text of texts) {
      for (const links of [[], [link("1")], [link("1"), link("2")]]) {
        const view = { text, links };
        expect(composerViewOfDraft(joinComposerDraft(text, links), view)).toBe(view);
      }
    }
    // A draft changed elsewhere (another device, an edit begun) is read afresh.
    expect(composerViewOfDraft(`Look\n\n${link("1").url}`, { text: "Lo", links: [] })).toEqual({ text: "Look", links: [link("1")] });
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

  test("only a lone share link pasted at the end of the draft is a chip; anything else stays text as pasted", () => {
    expect(pastedShareChips(link("1").url, "", [])).toEqual([link("1")]);
    expect(pastedShareChips(` ${link("1").url}\n`, " ", [link("2")])).toEqual([link("1")]);
    // Inside a sentence, or with words of its own, it stays where it was put.
    expect(pastedShareChips(link("1").url, " for the chain", [])).toBeNull();
    expect(pastedShareChips(`look ${link("1").url}`, "", [])).toBeNull();
    expect(pastedShareChips(`${link("1").url} ${link("2").url}`, "", [])).toBeNull();
    // A share that already has a chip adds none; past the chips a message draws, it stays text.
    expect(pastedShareChips(link("1").url, "", [link("1")])).toEqual([]);
    expect(pastedShareChips(link("4").url, "", ["1", "2", "3"].map(link))).toBeNull();
    expect(pastedShareChips("https://gloom.sh/docs", "", [])).toBeNull();
    expect(pastedShareChips(`https://term.gloom.sh.example.com/s/${"1".repeat(32)}`, "", [])).toBeNull();
  });
});
