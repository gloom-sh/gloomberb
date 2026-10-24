/**
 * Text as typed, with the compatibility forms an East Asian keyboard writes
 * folded to the characters they stand for (Unicode NFKC): full-width letters,
 * digits and signs (ＧＭＥ, １０, ＄) are ASCII, an ideographic space is a
 * space and half-width katakana are full width. Kana, kanji, hangul and
 * accented letters are kept.
 */
export function foldTypedText(text: string): string {
  return text.normalize("NFKC");
}

/** A letter of a script other than Latin: kana, kanji, hangul, Cyrillic. */
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}]/u;

/**
 * Whether text has letters in a script other than Latin (任天堂, ゲームストップ,
 * Газпром). Listings are named in Latin letters, so such a name finds none.
 */
export function hasNonLatinLetters(text: string): boolean {
  return NON_LATIN_LETTER.test(text);
}
