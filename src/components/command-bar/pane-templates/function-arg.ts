import type { PaneTemplateDef } from "../../../types/plugin";
import { logFailure } from "../../../utils/log-failure";
import { getPaneShortcutArgKind } from "../routes/root/shortcuts";

/**
 * What a pane function takes after its code when somebody else wrote the
 * command: a code in a chat message, or a link. Only an argument that names
 * something to look at. Free text is what some functions act on as they open
 * (ASKG asks it, THESIS starts one), which a click on somebody else's words
 * must never do, so a function that takes free text counts as taking none,
 * unless its template says the text only picks what the pane shows
 * (`argOnlySelects`).
 */
export type FunctionArgKind =
  /** Nothing: the code alone. */
  | "none"
  /** One ticker: `DES AAPL`. */
  | "ticker"
  /** One or more tickers: `CMP AAPL MSFT`. */
  | "tickers"
  /** One of the values the function names: `NI CRYPTO`. */
  | "choice"
  /** One word that only picks what the pane shows: `PERP BTC`, `GC US`. */
  | "selection";

export interface FunctionArg {
  arg: FunctionArgKind;
  /** For a choice or a selection, the values it names. */
  choices?: () => readonly string[];
}

export function paneTemplateFunctionArg(template: PaneTemplateDef): FunctionArg {
  const kind = getPaneShortcutArgKind(template);
  if (kind === "ticker") return { arg: "ticker" };
  if (kind === "ticker-list") return { arg: "tickers" };
  if (kind !== "text") return { arg: "none" };
  const options = template.shortcut?.argOptions;
  const choices = options ? { choices: () => options().map((option) => option.value) } : {};
  if (template.shortcut?.argOnlySelects) return { arg: "selection", ...choices };
  return options ? { arg: "choice", ...choices } : { arg: "none" };
}

const MAX_TICKERS = 12;
/** A symbol as written: AAPL, BRK.B, BTC-USD, ES=F, SMSN:LSE, ^GSPC. With a letter, so `GP 100` is not one. */
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.:=/!-]{0,23}$/;

/**
 * One word, as a link carries it: capitals, digits and the marks symbols and
 * codes use (`BTC`, `US10Y`, `US,JP`, `0001067983`), so a sentence after a
 * code (`G is great`) stays text.
 */
const SELECTION_RE = /^[A-Z0-9^$][A-Z0-9.:=/!^$,_-]{0,63}$/;

const isTicker = (word: string) => TICKER_RE.test(word) && /[A-Z]/.test(word);

function namesChoice(fn: { choices?: () => readonly string[] }, arg: string): boolean {
  const wanted = arg.toUpperCase();
  try {
    return fn.choices?.().some((value) => value.toUpperCase() === wanted) ?? false;
  } catch (error) {
    // A plugin's list that throws names no value, so the argument is not one of them.
    return logFailure("command-bar.function-arg", "Reading a function's argument values failed", false)(error);
  }
}

/**
 * Whether `arg` is what the function takes from somebody else: a ticker in
 * capitals, a list of them, one of the values it names, or for a function
 * whose text only picks what it shows, one word. Other free text never is.
 */
export function acceptsFunctionArg(fn: { arg: string; choices?: () => readonly string[] }, arg: string): boolean {
  switch (fn.arg) {
    case "ticker":
      return isTicker(arg);
    case "tickers": {
      const words = arg.split(/[\s,]+/).filter(Boolean);
      return words.length > 0 && words.length <= MAX_TICKERS && words.every(isTicker);
    }
    case "choice":
      return namesChoice(fn, arg);
    case "selection":
      return namesChoice(fn, arg) || SELECTION_RE.test(arg);
    default:
      return false;
  }
}
