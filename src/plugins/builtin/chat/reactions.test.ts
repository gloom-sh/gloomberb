import { describe, expect, test } from "bun:test";
import { resolveRenderLib } from "@opentui/core";
import type { ChatReaction } from "../../../api-client";
import {
  CHAT_REACTION_PALETTE,
  reactedByText,
  terminalReactionGlyph,
  terminalReactionRows,
  withOwnReaction,
} from "./reactions";

/** The cells the terminal renderer gives a string, in each of its width modes. */
function rendererWidths(text: string): number[] {
  const lib = resolveRenderLib();
  return (["unicode", "wcwidth"] as const).map((method) => {
    const encoded = lib.encodeUnicode(text, method);
    const width = (encoded?.data ?? []).reduce((total: number, char: { width: number }) => total + char.width, 0);
    if (encoded) lib.freeUnicode(encoded);
    return width;
  });
}

/** Every emoji that has a text style, which is where renderers and terminals disagree. */
function textStyleEmoji(): string[] {
  const found: string[] = [];
  for (let value = 0xa9; value <= 0x1faff; value += 1) {
    const point = String.fromCodePoint(value);
    if (!/^\p{Emoji}$/u.test(point) || /^\p{Emoji_Presentation}$/u.test(point)) continue;
    if (/^[0-9#*]$/.test(point) || /\p{Regional_Indicator}/u.test(point) || (value >= 0x1f3fb && value <= 0x1f3ff)) continue;
    found.push(point, `${point}\ufe0f`);
  }
  return found;
}

describe("terminal reaction glyphs", () => {
  test("the renderer gives every glyph the width the chips are laid out with, in both width modes", () => {
    const samples = [
      ...CHAT_REACTION_PALETTE,
      ...textStyleEmoji(),
      "🎉", "👍🏽", "👨‍💻", "🏳️‍🌈", "🇯🇵", "1️⃣", "#️⃣", ":gloomcat:", ":a_very_long_custom_emoji_name:",
    ];
    const mismatched = samples.flatMap((emoji) => {
      const glyph = terminalReactionGlyph(emoji);
      const widths = rendererWidths(glyph.text);
      return widths.every((width) => width === glyph.width) ? [] : [`${emoji} -> ${glyph.text} ${glyph.width} vs ${widths.join("/")}`];
    });
    expect(mismatched).toEqual([]);
  });

  test("terminals draw a text-style emoji one cell wide bare and two with its selector, so the glyph picks one", () => {
    expect(terminalReactionGlyph("❤️")).toEqual({ text: "❤️", width: 2 });
    expect(terminalReactionGlyph("☀️")).toEqual({ text: "☀", width: 1 });
    expect(terminalReactionGlyph("🇯🇵")).toEqual({ text: "JP", width: 2 });
    expect(terminalReactionGlyph("👍🏽").text).toBe("👍");
  });
});

describe("reaction state", () => {
  const self = { id: "me", username: "vince", displayName: "Vince" };
  const reactions: ChatReaction[] = [
    { emoji: "👍", count: 2, me: false, users: [{ id: "a", username: "anna", displayName: "Anna" }, { id: "b", username: "bo", displayName: "Bo" }] },
    { emoji: "🔥", count: 1, me: true, users: [self] },
  ];

  test("your own reaction moves the chip at once: added at the end, taken back to nothing", () => {
    expect(withOwnReaction(reactions, "👍", true, self)[0]).toMatchObject({ count: 3, me: true });
    expect(withOwnReaction(reactions, "🔥", false, self).map((reaction) => reaction.emoji)).toEqual(["👍"]);
    expect(withOwnReaction(reactions, "🚀", true, self).at(-1)).toMatchObject({ emoji: "🚀", count: 1, me: true });
    // Setting what is already there changes nothing.
    expect(withOwnReaction(reactions, "🔥", true, self)).toEqual(reactions);
  });

  test("who reacted names you first and counts the rest", () => {
    expect(reactedByText({ ...reactions[0]!, count: 5 }, "me")).toBe("anna, bo and 3 others");
    expect(reactedByText({ emoji: "🔥", count: 2, me: true, users: [{ id: "a", username: "anna", displayName: "Anna" }, self] }, "me")).toBe("you and anna");
  });

  test("chips wrap to a new row when the next one does not fit", () => {
    const many = ["👍", "🔥", "😂", "👀"].map((emoji) => ({ emoji, count: 12, me: false }));
    // Each chip is " 👍 12 " (7 cells), one cell apart.
    expect(terminalReactionRows(many, 15).map((row) => row.length)).toEqual([2, 2]);
    expect(terminalReactionRows(many, 31).map((row) => row.length)).toEqual([4]);
  });
});
