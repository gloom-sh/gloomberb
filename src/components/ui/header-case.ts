/**
 * Table headers and section headings read in one case everywhere, whatever
 * case a pane wrote them in. Greek letters keep theirs: σ and Σ mean different
 * things.
 */
export function headerCase(label: string): string {
  return label.replace(/[^Ͱ-Ͽ]+/g, (run) => run.toLocaleUpperCase());
}
