import type { PaneTemplateDef } from "../../../types/plugin";
import { getPaneShortcutArgKind } from "../routes/root/shortcuts";

/**
 * What a pane function takes after its code when somebody else wrote the
 * command: a code in a chat message, or a link. Only an argument that names
 * something to look at. Free text is what some functions act on as they open
 * (ASKG asks it, THESIS starts one), which a click on somebody else's words
 * must never do, so a function that takes free text counts as taking none.
 */
export type FunctionArgKind =
  /** Nothing: the code alone. */
  | "none"
  /** One ticker: `DES AAPL`. */
  | "ticker"
  /** One or more tickers: `CMP AAPL MSFT`. */
  | "tickers"
  /** One of the values the function names: `NI CRYPTO`. */
  | "choice";

export interface FunctionArg {
  arg: FunctionArgKind;
  /** For a choice, the values it takes. */
  choices?: () => readonly string[];
}

export function paneTemplateFunctionArg(template: PaneTemplateDef): FunctionArg {
  const kind = getPaneShortcutArgKind(template);
  if (kind === "ticker") return { arg: "ticker" };
  if (kind === "ticker-list") return { arg: "tickers" };
  const options = template.shortcut?.argOptions;
  if (kind === "text" && options) return { arg: "choice", choices: () => options().map((option) => option.value) };
  return { arg: "none" };
}

const MAX_TICKERS = 12;
/** A symbol as written: AAPL, BRK.B, BTC-USD, ES=F, SMSN:LSE, ^GSPC. With a letter, so `GP 100` is not one. */
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.:=/!-]{0,23}$/;

const isTicker = (word: string) => TICKER_RE.test(word) && /[A-Z]/.test(word);

/**
 * Whether `arg` is what the function takes from somebody else: a ticker in
 * capitals, a list of them, or one of the values it names. Free text never is.
 */
export function acceptsFunctionArg(fn: { arg: string; choices?: () => readonly string[] }, arg: string): boolean {
  switch (fn.arg) {
    case "ticker":
      return isTicker(arg);
    case "tickers": {
      const words = arg.split(/[\s,]+/).filter(Boolean);
      return words.length > 0 && words.length <= MAX_TICKERS && words.every(isTicker);
    }
    case "choice": {
      const wanted = arg.toUpperCase();
      try {
        return fn.choices?.().some((value) => value.toUpperCase() === wanted) ?? false;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
