/**
 * What one cell of a pasted list or a typed argument is before anything is
 * looked up: a symbol, a figure (a price, a weight, a share count) or junk
 * a sheet leaves where a value is missing (`N/A`, `--`, `$$$`). Every list
 * reader and every lookup of a list's symbols decide it here, so a price
 * from a European sheet (`2.582,52`) is never searched for as a ticker.
 */

/** A sign before a figure: plus, hyphen-minus or the minus sign. */
const SIGN = "[+\\-\u2212]";
/** The currency marks a sheet writes beside an amount. */
const CURRENCY = "[$\u20ac\u00a3\u00a5\u20b9\u20a9\u20bd\u20ba\u20aa\u0e3f\u20ab\u00a2]";
/** Thousands written with an apostrophe (1'234.50) or a no-break or thin space (1 234,50). */
const GROUP_MARK = "['\u2019\u00a0\u202f\u2009]";
const FIGURE_BODY = [
  // 1,899.21 and 1,899: commas between thousands.
  "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?",
  // 2.582,52, 1.899 and 1.234.567: dots between thousands, a decimal comma.
  "\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?",
  `\\d{1,3}(?:${GROUP_MARK}\\d{3})+(?:[.,]\\d+)?`,
  // 2,5 and 12,345, and 1234,56: a decimal comma.
  "\\d{1,3},\\d+",
  "\\d+,\\d{1,2}",
  "\\d*\\.\\d+",
  "\\d+",
].join("|");
const FIGURE = new RegExp(
  `^(?:${SIGN}?${CURRENCY}?${SIGN}?(?:${FIGURE_BODY})(?:%|\u2030|${CURRENCY})?|\\(${CURRENCY}?(?:${FIGURE_BODY})%?\\))$`,
  "u",
);
/** A run of digits and the marks between them, where a comma may be a decimal comma rather than a list's separator. */
const FIGURE_RUN = new RegExp(`(?<![\\p{L}\\p{N}.])(?:${SIGN}|${CURRENCY})*\\d[\\d.,'\u2019\u00a0\u202f\u2009]*(?:%|\u2030|${CURRENCY})?`, "gu");
/** Placeholders a sheet writes for a missing value, and its error values: N/A, n.a., #N/A, #VALUE!. */
const PLACEHOLDER = /^(?:#?n\/a|n\.a\.?|#(?:value!|ref!|div\/0!|name\?|num!|null!|spill!|calc!|getting_data))$/i;
/** Stands in for a comma inside a figure while a line is split on its separators. */
const FIGURE_COMMA = "\u0000";

/**
 * A figure as a sheet or a keyboard writes it, a bare whole number (7203)
 * included: `2.582,52`, `1,899.21`, `-3.2%`, `€1.234,56`, `(1,234.56)`.
 */
export function isFigure(cell: string): boolean {
  return FIGURE.test(cell.trim());
}

/**
 * A figure that is never a symbol: one with a decimal or thousands mark, a
 * sign, a percent or a currency mark (`1.899`, `2,5`, `+4`, `12%`, `$12`). A
 * bare whole number is not one, as `7203` and `0700` are tickers on their own.
 */
export function isNumberCell(cell: string): boolean {
  const text = cell.trim();
  return FIGURE.test(text) && !/^\d+$/.test(text);
}

/** A cell that names nothing: no letter or digit (`$$$`, `--`, `-`, `…`), or a placeholder for a missing value (`N/A`, `#N/A`). */
export function isJunkCell(cell: string): boolean {
  const text = cell.trim();
  return !/[\p{L}\p{N}]/u.test(text) || PLACEHOLDER.test(text);
}

/** Why a cell is not a symbol, as a lookup refuses it without asking anything; null for one that may be. */
function notASymbolReason(cell: string): string | null {
  if (isJunkCell(cell)) return "not a symbol";
  if (isNumberCell(cell)) return "a number, not a symbol";
  return null;
}

/** An entry of a list that cannot be a symbol, refused before any lookup and never looked up again. */
export class NotASymbolError extends Error {
  constructor(readonly input: string, readonly reason: string) {
    super(`${input.trim()} is ${reason}.`);
    this.name = "NotASymbolError";
  }
}

/** `NotASymbolError` for a cell that is not a symbol, else null. */
export function notASymbolError(cell: string): NotASymbolError | null {
  const reason = notASymbolReason(cell);
  return reason ? new NotASymbolError(cell, reason) : null;
}

/**
 * The text with each comma inside a figure (`2.582,52`, `1,899.21`, `2,5`)
 * swapped for a stand-in, so splitting on commas leaves the figure whole;
 * `restoreFigureCommas` puts them back. A run that is no figure keeps its
 * commas as separators: `7203,6758` is two codes.
 */
export function protectFigureCommas(text: string): string {
  return text.replace(FIGURE_RUN, (run) => {
    const body = run.replace(/[.,'\u2019]+$/, "");
    const tail = run.slice(body.length);
    return body.includes(",") && isFigure(body) ? `${body.replaceAll(",", FIGURE_COMMA)}${tail}` : run;
  });
}

export function restoreFigureCommas(text: string): string {
  return text.replaceAll(FIGURE_COMMA, ",");
}
