/**
 * Whether a batch of DOM mutations changed what the page shows. React's
 * update of an input clears its `name` and sets it back, and sets its `type`
 * again, on every render of it, so a pane that re-renders without drawing
 * anything new (a throttled total catching up, a flash wearing off) would
 * keep a capture waiting on a page that has long stopped changing. An
 * attribute or a text that ends the batch as it began it has not changed.
 */
export function changedThePage(records: readonly MutationRecord[]): boolean {
  // Each attribute's and text's value before the batch: the old value of its first record.
  const before = new Map<Node, Map<string | null, string | null>>();
  for (const record of records) {
    if (record.type === "childList") return true;
    const key = record.type === "attributes" ? record.attributeName : null;
    let values = before.get(record.target);
    if (!values) before.set(record.target, values = new Map());
    if (!values.has(key)) values.set(key, record.oldValue);
  }
  for (const [node, values] of before) {
    for (const [name, old] of values) {
      const now = name == null ? node.textContent : (node as Element).getAttribute(name);
      if (now !== old) return true;
    }
  }
  return false;
}

/** What the capture's observer records: everything, with the old values `changedThePage` compares. */
export const SHOT_MUTATION_OPTIONS: MutationObserverInit = {
  attributes: true,
  attributeOldValue: true,
  childList: true,
  characterData: true,
  characterDataOldValue: true,
  subtree: true,
};
