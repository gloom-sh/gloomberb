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
 * leaving a marked cell out whatever its text.
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
      const text = textOf(cell);
      if (
        /…|\.\.\./.test(text)
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
    }).filter((cell) => cell.text.length > 0);
    if (cells.length === 0) return;
    rows.push({
      tableIndex,
      rowIndex,
      ...(rowKey ? { key: rowKey } : {}),
      selected: row.getAttribute("data-selected") === "true",
      cells,
    });
  });
  return { rows, clipped };
}
