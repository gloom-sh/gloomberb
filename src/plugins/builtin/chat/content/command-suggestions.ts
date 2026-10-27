import type { ChatFunction } from "../pane-links/commands";

/** A function offered after a backtick: its code and what it is called. */
export interface ChatCommandSuggestion {
  code: string;
  name: string;
  takesArg: boolean;
}

interface ChatCommandTrigger {
  /** Where the opening backtick is. */
  start: number;
  end: number;
  query: string;
}

// An opening backtick after a space or punctuation (not inside a word, not a
// second tick of a fence), then the start of a code.
const COMMAND_TRIGGER_RE = /(^|[\s([{<,.;:!?"'])`([A-Za-z][A-Za-z0-9+-]{0,11})$/;
const FENCE_RE = /^\s{0,3}```/;
const MAX_COMMAND_SUGGESTIONS = 5;

/**
 * The code being typed after an opening backtick, up to the cursor. A
 * backtick that closes a span already open on the line, or one inside a
 * fenced code block, starts no code.
 */
export function detectChatCommandTrigger(draft: string, cursorOffset: number): ChatCommandTrigger | null {
  const cursor = Math.max(0, Math.min(cursorOffset, draft.length));
  const beforeCursor = draft.slice(0, cursor);
  const match = beforeCursor.match(COMMAND_TRIGGER_RE);
  if (!match) return null;
  const query = match[2]!;
  const start = cursor - query.length - 1;
  const lines = draft.slice(0, start).split("\n");
  const line = lines[lines.length - 1]!;
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  if (lines.slice(0, -1).filter((previous) => FENCE_RE.test(previous)).length % 2 === 1) return null;
  return { start, end: cursor, query };
}

/**
 * The functions whose code starts with the query, the exact one and the
 * shortest first, then those with a word of their name that does, as people
 * are found by their handle or their name.
 */
export function filterCommandSuggestions(
  functions: ReadonlyMap<string, ChatFunction>,
  query: string,
  limit = MAX_COMMAND_SUGGESTIONS,
): ChatCommandSuggestion[] {
  const upper = query.trim().toUpperCase();
  if (!upper) return [];
  const lower = upper.toLowerCase();
  const byCode: ChatFunction[] = [];
  const byName: ChatFunction[] = [];
  for (const fn of new Set(functions.values())) {
    if (fn.unlisted) continue;
    if (fn.code.startsWith(upper) || fn.aliases.includes(upper)) byCode.push(fn);
    else if (fn.name.toLowerCase().split(/[\s/&()-]+/).some((word) => word.startsWith(lower))) byName.push(fn);
  }
  const rank = (fn: ChatFunction) => (fn.code === upper || fn.aliases.includes(upper) ? 0 : 1);
  byCode.sort((a, b) => rank(a) - rank(b) || a.code.length - b.code.length || a.code.localeCompare(b.code));
  byName.sort((a, b) => a.code.localeCompare(b.code));
  return [...byCode, ...byName].slice(0, Math.min(limit, MAX_COMMAND_SUGGESTIONS))
    .map(({ code, name, arg }) => ({ code, name, takesArg: arg !== "none" }));
}

/**
 * The code in place of what was typed, with the closing backtick. A function
 * that takes an argument leaves the cursor before it, after a space, for the
 * ticker or topic; any other leaves it after the span and a space.
 */
export function applyCommandSuggestion(
  draft: string,
  trigger: ChatCommandTrigger,
  suggestion: ChatCommandSuggestion,
): { draft: string; cursorOffset: number } {
  const before = draft.slice(0, trigger.start);
  let after = draft.slice(trigger.end);
  // A closing backtick already there is the one this span ends with.
  if (after.startsWith("`")) after = after.slice(1);
  const code = `\`${suggestion.code}`;
  if (suggestion.takesArg) {
    return { draft: `${before}${code} \`${after}`, cursorOffset: before.length + code.length + 1 };
  }
  // A space to go on writing after, unless the text there already goes on.
  const suffix = /^[\s.,;:!?)\]]/.test(after) ? "" : " ";
  return {
    draft: `${before}${code}\`${suffix}${after}`,
    cursorOffset: before.length + code.length + 1 + suffix.length,
  };
}
