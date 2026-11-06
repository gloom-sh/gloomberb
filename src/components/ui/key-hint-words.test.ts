import { describe, expect, test } from "bun:test";
import { keyHintCells, keyHintWords, type KeyHintSource } from "./key-hint-words";

describe("a key hint's words", () => {
  // What hints across the app and the registry's plugins write, and the words the
  // desktop shows after the keycap. The terminal keeps writing `[key]label`.
  const cases: Array<[KeyHintSource, string]> = [
    // The convention: the rest of a word the key starts, or a space and words of their own.
    [{ key: "s", label: "eries" }, "series"],
    [{ key: "a", label: "dd event" }, "add event"],
    [{ key: "c", label: "opy link" }, "copy link"],
    [{ key: "x", label: " remove" }, "remove"],
    [{ key: "v", label: " review (Pro)", title: "Review" }, "review (Pro)"],
    // Keys that are not one letter are always followed by words.
    [{ key: "Enter", label: "pick" }, "pick"],
    [{ key: "Esc", label: "tabs" }, "tabs"],
    [{ key: "/", label: "search" }, "search"],
    [{ key: "Ctrl+S", label: "save" }, "save"],
    [{ key: "$", label: "upgrade" }, "upgrade"],
    [{ key: "}", label: "" }, ""],
    // A whole word after a letter key, which the title or the id names.
    [{ id: "rearm", key: "m", label: "re-arm", title: "Re-arm" }, "re-arm"],
    [{ id: "stop", key: "x", label: "stop" }, "stop"],
    [{ id: "toggle", key: "e", label: "disable", title: "Disable" }, "disable"],
    [{ id: "mine", key: "i", label: "all tickers", title: "All Tickers" }, "all tickers"],
    // A label that undoes what the id names.
    [{ id: "mute", key: "m", label: "unmute" }, "unmute"],
    // The key inside a word of the title, not at its start.
    [{ id: "export", key: "x", label: "port all", title: "Export All" }, "export all"],
    [{ id: "expand", key: "x", label: "pand", title: "Expand Row" }, "expand"],
    // The rest of the word even when the id or title is another word.
    [{ id: "toggle", key: "e", label: "nable", title: "Disable" }, "enable"],
    [{ id: "settlement-table", key: "t", label: "able" }, "table"],
    [{ id: "pricer", key: "p", label: "rice" }, "price"],
    [{ id: "credit:des", key: "d", label: "es", title: "Description (DES)" }, "des"],
    // Without a title or an id that says: the key's own letter or a capital starts a word,
    // and capitals finish a code.
    [{ key: "r", label: "refresh" }, "refresh"],
    [{ key: "d", label: "Broker profile" }, "Broker profile"],
    [{ key: "t", label: "BO" }, "TBO"],
  ];

  test.each(cases)("%o reads %p", (hint, words) => {
    expect(keyHintWords(hint)).toBe(words);
  });
});

describe("a key hint's width on the desktop", () => {
  // What the web draws at a text size, as font-scale.ts sets it: the cell is 8px at 12px text and
  // scales with it, as does the type (12px text, 10px keycap caption). A monospace font advances
  // 0.6em. The spacing is pixels at every size: the keycap's 4px either side and 14px at least,
  // and 4px before the words.
  const grid = (fontPx: number) => {
    const scale = Math.round((fontPx / 12) * 100) / 100;
    return { cellPx: Math.round(8 * scale * 100) / 100, captionPx: 10 * scale, textPx: fontPx };
  };
  const drawnPx = (fontPx: number, keycap: string, words: string) => {
    const { captionPx, textPx } = grid(fontPx);
    return Math.max(14, keycap.length * 0.6 * captionPx + 8) + (words ? 4 + words.length * 0.6 * textPx : 0);
  };

  // The smallest, the default and the largest text sizes FONT- and FONT+ reach.
  test.each([10, 11, 12, 16, 20])("at %ipx text a hint is measured no narrower than the web draws it, so a row it fits never clips", (fontPx) => {
    const { cellPx } = grid(fontPx);
    for (const [keycap, words] of [["s", "series"], ["Esc", "tabs"], ["Ctrl+S", "save search"], ["}", ""], ["m", "re-arm"]] as const) {
      const measured = keyHintCells(keycap, words, cellPx) * cellPx;
      expect(measured).toBeGreaterThanOrEqual(drawnPx(fontPx, keycap, words));
      // ...and not so much wider that hints go under More for nothing.
      expect(measured).toBeLessThan(drawnPx(fontPx, keycap, words) * 1.08);
    }
  });

  test("a symbol counts a whole em of the caption, more than a letter, as a fallback font may draw it wider", () => {
    expect(keyHintCells("⌘⇧S", "")).toBeGreaterThan(keyHintCells("CSS", ""));
  });
});
