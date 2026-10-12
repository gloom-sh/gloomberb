import type { ChatMessage, ChatReaction, ChatReactionUser } from "../../../api-client";
import { chatAuthorName } from "./ghost-user";

/** The emoji the app offers, spelled as Discord spells them (the heart carries U+FE0F). */
export const CHAT_REACTION_PALETTE = ["👍", "🔥", "😂", "👀", "❤️", "🚀"] as const;

const CUSTOM_EMOJI = /^:[A-Za-z0-9_~-]{1,32}:$/;
const CUSTOM_EMOJI_TERMINAL_LIMIT = 16;
/** Names a "who reacted" line spells out before "and N others". */
const NAMED_REACTORS = 3;

/** A custom Discord server emoji, shown as its `:name:`; only Discord adds or removes it. */
export function isCustomReactionEmoji(emoji: string): boolean {
  return CUSTOM_EMOJI.test(emoji);
}

/** The message's reactions, never undefined. */
function messageReactions(message: Pick<ChatMessage, "reactions">): ChatReaction[] {
  return message.reactions ?? [];
}

/**
 * What the picker offers: the palette in its order, then any other emoji a
 * Discord member put on the message, each with its current count.
 */
export function reactionPickerChoices(message: Pick<ChatMessage, "reactions">): ChatReaction[] {
  const current = messageReactions(message);
  const byEmoji = new Map(current.map((reaction) => [reaction.emoji, reaction]));
  const palette = CHAT_REACTION_PALETTE.map((emoji) => byEmoji.get(emoji) ?? { emoji, count: 0, me: false, users: [] });
  const others = current.filter((reaction) => (
    !(CHAT_REACTION_PALETTE as readonly string[]).includes(reaction.emoji)
    && !isCustomReactionEmoji(reaction.emoji)
  ));
  return [...palette, ...others];
}

/**
 * The reactions with yours set or cleared, as the server will answer, so the
 * chip moves the moment it is pressed.
 */
export function withOwnReaction(
  reactions: readonly ChatReaction[],
  emoji: string,
  reacted: boolean,
  self: ChatReactionUser,
): ChatReaction[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (!existing) {
    return reacted ? [...reactions, { emoji, count: 1, me: true, users: [self] }] : [...reactions];
  }
  if (existing.me === reacted) return [...reactions];
  return reactions.flatMap((reaction) => {
    if (reaction.emoji !== emoji) return [reaction];
    const users = (reaction.users ?? []).filter((user) => user.id !== self.id);
    const count = Math.max(0, reaction.count + (reacted ? 1 : -1));
    if (count === 0) return [];
    return [{ ...reaction, count, me: reacted, users: reacted ? [...users, self] : users }];
  });
}

/** "you, vince and 2 others": who reacted, you first, then oldest first. */
export function reactedByText(reaction: ChatReaction, currentUserId: string | null | undefined): string {
  const others = (reaction.users ?? [])
    .filter((user) => user.id !== currentUserId)
    .map((user) => chatAuthorName({ ...user, accountType: user.accountType ?? undefined }));
  const names = reaction.me ? ["you", ...others] : others;
  const shown = names.slice(0, NAMED_REACTORS);
  const rest = Math.max(0, reaction.count - shown.length);
  if (shown.length === 0) return rest > 0 ? `${rest} ${rest === 1 ? "person" : "people"}` : "";
  if (rest === 0) {
    return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  }
  return `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

const VARIATION_SELECTOR = /[\ufe0e\ufe0f]/gu;
const SKIN_TONE = /[\u{1f3fb}-\u{1f3ff}]/gu;
const ZERO_WIDTH_JOINER = "\u200d";
const KEYCAP = /^([0-9#*])\u20e3$/u;
const REGIONAL_INDICATOR = /^[\u{1f1e6}-\u{1f1ff}]$/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const SINGLE_WIDTH_TEXT = /^[\x20-\x7e]+$/;
/**
 * Text-style emoji the terminal renderer measures two cells wide even without
 * a variation selector (and the text-style ones from U+1F549 on). Terminals
 * draw them one cell wide bare and two with U+FE0F, so they keep the selector.
 */
const WIDE_TEXT_STYLE_EMOJI = new Set([
  0x203c, 0x2049, 0x2622, 0x2623, 0x269b, 0x26d1, 0x2763, 0x2764, 0x3030, 0x303d, 0x3297, 0x3299,
  0x1f202, 0x1f237,
]);

function isWideTextStyleEmoji(value: number): boolean {
  return WIDE_TEXT_STYLE_EMOJI.has(value) || (value >= 0x1f549 && value <= 0x1f5ff);
}

/**
 * An emoji as the terminal draws it, in a form the renderer and the terminal
 * give the same width, so nothing after it on the row shifts or leaves a
 * stale cell behind. A single wide emoji stays as it is. A text-style symbol
 * (☀️) goes bare and one cell wide, except the few the renderer always
 * counts as two (❤️), which keep U+FE0F so the terminal draws them two wide
 * as well. Skin tones and joined sequences fall back to their first emoji;
 * flags and keycaps become their letters, which renderers count differently
 * depending on the terminal. `width` is the cells it takes.
 */
export function terminalReactionGlyph(emoji: string): { text: string; width: number } {
  if (isCustomReactionEmoji(emoji)) {
    const text = emoji.length > CUSTOM_EMOJI_TERMINAL_LIMIT
      ? `${emoji.slice(0, CUSTOM_EMOJI_TERMINAL_LIMIT - 2)}…:`
      : emoji;
    return { text, width: text.length };
  }
  const base = emoji.replace(VARIATION_SELECTOR, "").replace(SKIN_TONE, "").split(ZERO_WIDTH_JOINER)[0] ?? "";
  const keycap = KEYCAP.exec(base);
  if (keycap) return { text: `[${keycap[1]}]`, width: 3 };
  const codePoints = Array.from(base);
  if (codePoints.length === 2 && codePoints.every((point) => REGIONAL_INDICATOR.test(point))) {
    const text = codePoints.map((point) => String.fromCharCode(point.codePointAt(0)! - 0x1f1e6 + 65)).join("");
    return { text, width: 2 };
  }
  if (codePoints.length === 1) {
    const point = codePoints[0]!;
    const value = point.codePointAt(0)!;
    if (EMOJI_PRESENTATION.test(point)) return { text: point, width: 2 };
    if (isWideTextStyleEmoji(value)) return { text: `${point}\ufe0f`, width: 2 };
    if (value >= 0xa9) return { text: point, width: 1 };
  }
  if (SINGLE_WIDTH_TEXT.test(base)) return { text: base, width: base.length };
  return { text: "?", width: 1 };
}

/** A chip's text: the emoji (in its terminal form there) and the count. */
export function reactionChipText(reaction: ChatReaction, host: "terminal" | "desktop"): string {
  const glyph = host === "terminal" ? terminalReactionGlyph(reaction.emoji).text : reaction.emoji;
  return `${glyph} ${reaction.count}`;
}

/** Cells a terminal chip takes: a space each side of the glyph and count. */
export function terminalReactionChipWidth(reaction: ChatReaction): number {
  return terminalReactionGlyph(reaction.emoji).width + 1 + String(reaction.count).length + 2;
}

/** The terminal's chip rows under a message: chips one cell apart, a new row when the next does not fit. */
export function terminalReactionRows(reactions: readonly ChatReaction[], width: number): ChatReaction[][] {
  const rows: ChatReaction[][] = [];
  let row: ChatReaction[] = [];
  let used = 0;
  for (const reaction of reactions) {
    const chip = terminalReactionChipWidth(reaction);
    const needed = row.length === 0 ? chip : used + 1 + chip;
    if (row.length > 0 && needed > width) {
      rows.push(row);
      row = [reaction];
      used = chip;
      continue;
    }
    row.push(reaction);
    used = needed;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** What the server leaves in place of a message taken down in the app or deleted on Discord. */
const TAKEN_DOWN_PLACEHOLDERS = new Set(["(message removed)", "(message deleted)"]);

/** Whether a message can take a reaction from here: sent, cleared for everyone, and not taken down. */
export function canReactToMessage(message: ChatMessage): boolean {
  return !message.clientStatus
    && !message.id.startsWith("local:")
    && !message.attachmentReview
    && !TAKEN_DOWN_PLACEHOLDERS.has(message.content);
}

/**
 * The terminal picker's rows: a box ticked for your own, the count, and who
 * reacted under the list. An emoji the terminal draws like an earlier row (a
 * skin tone of 👍) is left to its chip, so no two rows look the same.
 */
export function terminalReactionChoices(
  message: Pick<ChatMessage, "reactions">,
  currentUserId: string | null | undefined,
): Array<{ id: string; label: string; detail?: string; description: string }> {
  const drawn = new Set<string>();
  return reactionPickerChoices(message).flatMap((reaction) => {
    const glyph = terminalReactionGlyph(reaction.emoji).text;
    if (drawn.has(glyph)) return [];
    drawn.add(glyph);
    return [{
      id: reaction.emoji,
      label: `${reaction.me ? "[x]" : "[ ]"} ${glyph}`,
      ...(reaction.count > 0 ? { detail: String(reaction.count) } : {}),
      description: reaction.count > 0 ? reactedByText(reaction, currentUserId) : "",
    }];
  });
}
