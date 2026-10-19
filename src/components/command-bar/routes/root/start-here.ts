import type { PaneTemplateDef } from "../../../../types/plugin";
import type { ResultItem } from "../../list/model";
import { paneTemplateShortcutPrefixes } from "../../pane-templates/items";

const START_HERE_CATEGORY = "Start Here";

interface StartHereRow {
  /** What the user wants, in their words. */
  label: string;
  /** The codes that do it, best first: a host or plugin set without the first falls back to the next. */
  codes: readonly string[];
}

/**
 * The empty bar's first group, for someone who does not know a code yet. Each
 * row runs the same function its code's own row runs, so nothing here is a
 * second way of doing anything; the browse list below still lists them all.
 */
const START_HERE_ROWS: readonly StartHereRow[] = [
  { label: "Look up a company", codes: ["DES"] },
  { label: "Ask Gloom a question", codes: ["ASKG"] },
  { label: "Chart a stock", codes: ["GP"] },
  // A comparison chart needs two tickers; with one already loaded it is not
  // offered, and relative valuation compares that one with its peers.
  { label: "Compare stocks", codes: ["CMP", "RV"] },
  { label: "See who reports earnings", codes: ["ERN"] },
  // The web has no market movers; the heat map shows the same day.
  { label: "See what is moving today", codes: ["MOST", "HM"] },
  { label: "Read the top news", codes: ["TOP"] },
  { label: "Screen for ideas", codes: ["EQS"] },
  { label: "Check the economy", codes: ["ECO"] },
  { label: "Track your portfolio", codes: ["PF"] },
];

const SECURITY_DESCRIPTION_CODE = "DES";

interface StartHereSources {
  /** The pane templates typing `code` would open, as the bar resolves a typed code. */
  templatesForCode: (code: string) => readonly PaneTemplateDef[];
  /** The row the browse list draws for a template. */
  createTemplateItem: (template: PaneTemplateDef) => ResultItem;
  /** Opens the ticker search DES runs on, or null when DES is not available. */
  lookUpCompany: (() => void) | null;
}

function resolveCodeItem(code: string, sources: StartHereSources): ResultItem | null {
  if (code === SECURITY_DESCRIPTION_CODE) {
    const lookUp = sources.lookUpCompany;
    if (!lookUp) return null;
    return {
      id: "security-description",
      label: "Description",
      detail: "Search for a ticker and open its security details",
      category: START_HERE_CATEGORY,
      kind: "command",
      action: lookUp,
    };
  }
  const template = sources.templatesForCode(code).find((candidate) => (
    paneTemplateShortcutPrefixes(candidate).some((prefix) => prefix.toUpperCase() === code)
  ));
  return template ? sources.createTemplateItem(template) : null;
}

/**
 * One row per entry whose function is available here, labelled with what it
 * does and its code on the right. A row runs exactly what its code's row in
 * the list runs; an entry none of whose codes is available is left out.
 */
export function buildStartHereItems(sources: StartHereSources): ResultItem[] {
  const items: ResultItem[] = [];
  for (const row of START_HERE_ROWS) {
    for (const code of row.codes) {
      const item = resolveCodeItem(code, sources);
      if (!item || item.disabled) continue;
      items.push({
        ...item,
        id: `start-here:${code}`,
        label: row.label,
        category: START_HERE_CATEGORY,
        right: code,
        shortcutQuery: code,
        badge: undefined,
        shortcutOnRight: true,
      });
      break;
    }
  }
  return items;
}
