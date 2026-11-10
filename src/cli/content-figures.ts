/**
 * The blocks of text with a figure in them that a pane's body shows, outside
 * its controls, chrome, states and charts, and outside the labels of its
 * tables and labelled values: what a capture of a pane that marks no rows
 * (DIAG's prose, CORR's matrix) is read by.
 *
 * A block is the element a run of text lays out in: the inline pieces of one
 * line (`Page {a} of {b}`, which React writes as several text nodes, or a
 * figure in a span) count once. A label is not data: "52W High" or "10Y" over
 * a "-" is an empty grid, as `filledKeyValueCount` reads it.
 *
 * Self-contained so the screenshot runner can evaluate it in the browser.
 */
export function countContentFigures(root: HTMLElement, isVisible: (element: Element) => boolean): number {
  const view = root.ownerDocument.defaultView!;
  const body = root.querySelector<HTMLElement>('[data-gloom-role="pane-body"]') ?? root;
  // Controls, chrome and states say nothing of data, and a chart counts what it plots: "1M" on a tab is not a figure.
  const outside = [
    "button", '[role="button"]', '[role="tab"]', '[role="tablist"]', "input", "textarea", "select", "svg", "canvas",
    '[data-gloom-role="query-bar"]', '[data-gloom-role="pane-header"]', '[data-gloom-role="pane-footer"]', '[data-gloom-role="tab-list"]',
    '[data-gloom-role="page-stack-header"]', '[data-gloom-role="shot-watermark"]', '[data-gloom-role*="chart"]',
    '[data-gloom-ui="empty-state"]', '[data-gloom-ui="notice"]', '[data-gloom-ui="pane-status"]', '[data-gloom-ui="sign-in-wall"]',
    '[data-gloom-ui="pro-lock"]',
    // A table's header names its columns.
    "th", "thead", '[role="columnheader"]', '[role="rowheader"]', '[data-gloom-role="data-table-header-row"]',
    '[data-gloom-role="data-table-header-cell"]',
  ].join(", ");
  const labelled = '[data-gloom-ui="key-value-row"], [data-gloom-role="stat-grid-cell"]';
  const blocks = new Set<Element>();
  // 4 is NodeFilter.SHOW_TEXT, named by number so the function carries no global it might not find.
  const walker = root.ownerDocument.createTreeWalker(body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !/\d/.test(node.textContent ?? "") || parent.closest(outside) || !isVisible(parent)) continue;
    // A labelled value's label is its first child: its value is the figure, if it has one.
    if (parent.closest(labelled)?.firstElementChild?.contains(parent)) continue;
    // An element that lays out inline (or names no display) is part of its parent's line.
    let block: Element = parent;
    while (block !== body && block.parentElement && /^(inline|contents|$)/.test(view.getComputedStyle(block).display)) {
      block = block.parentElement;
    }
    blocks.add(block);
  }
  return blocks.size;
}
