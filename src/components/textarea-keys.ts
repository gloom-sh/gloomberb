/**
 * Enter starts a new line; Shift+Enter sends. Terminals without the kitty
 * keyboard protocol report Shift+Enter as Enter, so Alt+Enter also sends there.
 * Pass as `keyBindings` to a terminal Textarea whose `onSubmit` sends.
 */
export const TERMINAL_MESSAGE_KEYS = [
  { name: "return", action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "return", shift: true, action: "submit" },
  { name: "linefeed", shift: true, action: "submit" },
  { name: "return", meta: true, action: "submit" },
  { name: "linefeed", meta: true, action: "submit" },
];
