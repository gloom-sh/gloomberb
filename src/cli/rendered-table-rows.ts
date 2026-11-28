import type { DesktopPaneShotRenderedRow } from "./desktop-pane-shot";

/** A column as the table's own node names it (`metadata.columns`), read loosely: it crosses the page boundary. */
interface RenderedTableColumn {
  id?: unknown;
  label?: unknown;
  mayBeBlank?: unknown;
}

/**
 * The rows one table draws, as a capture reads them: each visible row's cells
 * with their column, text, exact value, and whether the cell may be blank with
 * nothing missing. That is the column's own word (`DataTableColumn.mayBeBlank`)
 * or the cell's (`DataTableCell.mayBeBlank`, drawn as
 * `data-gloom-cell-may-be-blank`), and `--strict` reads a blank column by it,
 * leaving a marked cell out whatever its text. A cell drawn with
 * `data-gloom-cell-report-text` is read as that text, and a row's
 * `data-gloom-row-report-cells` puts back the cells of a column the table
 * left out as drawn-blank (DataTableProps.reportTextColumns).
 * A cell with no text is left out, and a row with none.
 *
 * `clipped` is set when a cell shows an ellipsis or holds text wider than itself.
 *
 * Self-contained so the screenshot runner can evaluate it in the browser.
 */
export function readRenderedTableRows(
  table: Element,
  tableIndex: number,
  semanticColumns: readonly RenderedTableColumn[],
  isVisible: (element: Element) => boolean,
): { rows: DesktopPaneShotRenderedRow[]; clipped: boolean } {
  const normalize = (value: unknown) => String(value || "").replace(/\s+/g, " ").trim();
  const textOf = (element: Element) => normalize((element as HTMLElement).innerText);
  const headers = Array.from(table.querySelectorAll('[data-gloom-role="data-table-header-cell"]')).map(textOf);
  const rows: DesktopPaneShotRenderedRow[] = [];
  let clipped = false;
  const rowElements = Array.from(table.querySelectorAll(
    '[data-gloom-role="data-table-row"], [data-gloom-role="data-table-section-header"]',
  )).filter(isVisible);
  rowElements.forEach((row, rowIndex) => {
    const cellElements = Array.from(row.querySelectorAll('[data-gloom-role="data-table-cell"]'));
    const values = cellElements.length > 0 ? cellElements : [row];
    const rowKey = row.getAttribute("data-gloom-row-key");
    const cells = values.map((cell, cellIndex) => {
      const semanticColumn = semanticColumns[cellIndex] || {};
      const drawn = textOf(cell);
      // A cell whose drawn text leans on the pane around it says what a report reads instead (DataTableCell.reportText).
      const reported = cell.getAttribute("data-gloom-cell-report-text");
      const text = reported != null ? normalize(reported) : drawn;
      if (
        /…|\.\.\./.test(drawn)
        || [cell, ...Array.from(cell.querySelectorAll("*"))].some((node) => isVisible(node) && node.scrollWidth > node.clientWidth + 1)
      ) {
        clipped = true;
      }
      const instant = cell.getAttribute("data-gloom-cell-instant");
      const exact = Number(cell.getAttribute("data-gloom-cell-value") || "NaN");
      return {
        ...(typeof semanticColumn.id === "string" ? { columnId: semanticColumn.id } : {}),
        ...(semanticColumn.mayBeBlank === true || cell.getAttribute("data-gloom-cell-may-be-blank") === "true"
          ? { mayBeBlank: true as const }
          : {}),
        columnLabel: typeof semanticColumn.label === "string"
          ? semanticColumn.label
          : headers[cellIndex] || (values.length === 1 ? "Row" : String(cellIndex + 1)),
        text,
        ...(instant ? { instant } : {}),
        ...(Number.isFinite(exact) ? { value: exact } : {}),
      };
    });
    // A column the table left out as drawn-blank, whose cells still say what a report reads (FDA's Drug under the
    // drug its search names), goes back at the drawn index it would take.
    let leftOut: Array<{ at?: unknown; columnId?: unknown; columnLabel?: unknown; text?: unknown }> = [];
    try { leftOut = JSON.parse(row.getAttribute("data-gloom-row-report-cells") || "[]"); } catch { /* Intentional ignore: an unreadable attribute adds no cell. */ }
    let inserted = 0;
    for (const extra of Array.isArray(leftOut) ? leftOut : []) {
      const text = normalize(extra && extra.text);
      if (!text || typeof extra.at !== "number") continue;
      cells.splice(Math.min(cells.length, extra.at + inserted), 0, {
        ...(typeof extra.columnId === "string" ? { columnId: extra.columnId } : {}),
        columnLabel: typeof extra.columnLabel === "string" ? extra.columnLabel : String(extra.at + 1),
        text,
      });
      inserted += 1;
    }
    const kept = cells.filter((cell) => cell.text.length > 0);
    if (kept.length === 0) return;
    rows.push({
      tableIndex,
      rowIndex,
      ...(rowKey ? { key: rowKey } : {}),
      selected: row.getAttribute("data-selected") === "true",
      cells: kept,
    });
  });
  return { rows, clipped };
}
