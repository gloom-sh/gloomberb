/**
 * Terminal escape sequences: a CSI (`ESC [` or its one-byte C1 form) to its
 * final byte, an OSC, DCS, SOS, PM or APC string to its BEL or ST (or the
 * end), and the two-byte escapes.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|\u001b[ -/]*[0-~]/g;
/** Marks that turn, embed or hide text without showing themselves: bidi controls and zero-width characters. */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** Half of a broken surrogate pair, which no font draws and Postgres does not store. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** C0 and C1 controls: a line, a tab, a bell, what a terminal takes as a command. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Text another person's app wrote (a shared pane's item, a share's title), as
 * one line that draws as what it says: no terminal escape sequence, control
 * character, bidi control or zero-width character, and no broken surrogate
 * pair. The share service keeps an item's text to the same rule.
 */
export function plainUntrustedLine(value: string): string {
  return value
    .replace(ESCAPE_SEQUENCE, "")
    .replace(INVISIBLE, "")
    .replace(LONE_SURROGATE, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
}
