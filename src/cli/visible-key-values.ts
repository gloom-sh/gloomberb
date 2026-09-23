/** Self-contained so the screenshot runner can evaluate it in the browser. */
export function readVisibleKeyValues(root: HTMLElement): Array<{ label: string; text: string }> {
  const view = root.ownerDocument.defaultView!;
  // A stat grid cell is a labelled value too: label first, then the figure.
  const rows = root.querySelectorAll<HTMLElement>('[data-gloom-ui="key-value-row"], [data-gloom-role="stat-grid-cell"]');
  return Array.from(rows).flatMap((row) => {
    const rect = row.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    let left = 0, top = 0, right = view.innerWidth, bottom = view.innerHeight;
    for (let element: HTMLElement | null = row; element; element = element.parentElement) {
      const style = view.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return [];
      if (element === row) continue;
      const bounds = element.getBoundingClientRect();
      if (/^(hidden|clip|scroll|auto)$/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (/^(hidden|clip|scroll|auto)$/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
    // One CSS pixel permits fractional borders, not a clipped line of text.
    if (rect.left < left - 1 || rect.right > right + 1 || rect.top < top - 1 || rect.bottom > bottom + 1) return [];
    const text = (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || /\u2026|\.\.\./.test(text)) return [];
    const label = row.firstElementChild?.textContent?.trim() ?? "";
    return label ? [{ label, text }] : [];
  });
}
