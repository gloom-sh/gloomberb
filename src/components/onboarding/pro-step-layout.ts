import { wrapTextLines } from "../../utils/text-wrap";

function wrappedRows(text: string, width: number): number {
  return Math.max(1, wrapTextLines(text, Math.max(1, width)).length);
}

/**
 * Rows for each feature of a ranked list in `budget` rows: a title and its
 * wrapped description (`1 + descriptionRows[i]`), a title alone (1) or nothing
 * (0). As many features from the top keep their description as leave a row for
 * every one below them; when not even the titles fit, the lowest ranked drop.
 */
export function planProFeatureRows(budget: number, descriptionRows: readonly number[]): number[] {
  const count = descriptionRows.length;
  if (budget < count) return descriptionRows.map((_, index) => (index < budget ? 1 : 0));
  let spare = budget - count;
  const rows = descriptionRows.map(() => 1);
  for (const [index, description] of descriptionRows.entries()) {
    if (description > spare) break;
    spare -= description;
    rows[index] = 1 + description;
  }
  return rows;
}

/**
 * Rows a row of buttons takes in `columns` cells when it wraps to the next row
 * instead of running off the card: `widths` are the buttons' cells in order,
 * with one cell between neighbours on a row. A button wider than the row still
 * gets a row of its own.
 */
export function wrappedActionRows(widths: readonly number[], columns: number): number {
  let rows = 1;
  let used = 0;
  for (const width of widths) {
    if (used > 0 && used + 1 + width > columns) {
      rows += 1;
      used = width;
    } else {
      used += (used > 0 ? 1 : 0) + width;
    }
  }
  return rows;
}

export interface ProStepLayoutInput {
  /** Rows and columns inside the card's border and padding. */
  rows: number;
  columns: number;
  /** The line under the price. */
  note: string;
  /** The Monthly/Yearly control is shown. */
  interval: boolean;
  /** A persistence error line above the actions, or null. */
  error: string | null;
  /** Cells each action button takes; a row that does not fit wraps and costs a row more. */
  actions: readonly number[];
  /** Feature descriptions, ranked. */
  descriptions: readonly string[];
}

/**
 * What the terminal Pro step shows in a card of a given size: the whole list
 * with the step's usual blank rows while it fits, otherwise those rows go
 * (`compact`) and the list degrades as `planProFeatureRows` says. The actions
 * are never part of the budget the list gets: they keep the rows they need,
 * more than one when the buttons wrap.
 */
export function planProStep(input: ProStepLayoutInput): { compact: boolean; featureRows: number[] } {
  const { rows, columns, note, interval, error, actions, descriptions } = input;
  const noteRows = wrappedRows(note, columns);
  const errorRows = error ? wrappedRows(error, columns) : 0;
  const actionRows = wrappedActionRows(actions, columns);
  const descriptionRows = descriptions.map((description) => wrappedRows(description, columns - 2));
  // Header, step and title lines, the note, the control, the error, the actions.
  const around = (compact: boolean) => 1 + 2
    + (compact ? noteRows : 1 + Math.max(2, noteRows))
    + (interval ? (compact ? 1 : 2) : 0)
    + errorRows + actionRows;

  const roomy = planProFeatureRows(rows - around(false), descriptionRows);
  if (roomy.every((featureRows, index) => featureRows === 1 + descriptionRows[index]!)) {
    return { compact: false, featureRows: roomy };
  }
  return { compact: true, featureRows: planProFeatureRows(rows - around(true), descriptionRows) };
}
