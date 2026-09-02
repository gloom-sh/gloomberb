import { matchPrefix, type Command } from "./commands/registry";
import { t, tf } from "../../i18n";
import { truncateToDisplayWidth } from "../../utils/format";

export { rankTickerSearchItems } from "../../tickers/search";

/**
 * Drop repeats of an id, keeping the first. The root list is assembled from
 * overlapping sources (pane shortcuts, commands, plugin commands, ticker
 * actions, layout items) in priority order, so the first hit is the one whose
 * category and detail fit best.
 */
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export type CommandBarMode = "default" | "search" | "themes" | "layout" | "direct-command";

export interface CommandBarModeInfo {
  kind: CommandBarMode;
  badge: string;
  hint: string;
}

export interface CommandBarSection<T> {
  category: string;
  items: T[];
}

export type CommandBarSectionOrder = "default" | "app-first" | "ranked";

/** Sort positions contributed by plugin search providers, keyed by section heading. */
export type CommandBarCategoryPriorities = ReadonlyMap<string, number>;

export interface CommandBarSectionOptions {
  sectionOrder?: CommandBarSectionOrder;
  categoryPriorities?: CommandBarCategoryPriorities;
}

export interface CommandBarItemView {
  id: string;
  label: string;
  detail: string;
  category: string;
  kind: "command" | "ticker" | "search" | "plugin" | "action" | "info";
  right?: string;
  checked?: boolean;
  current?: boolean;
  accent?: boolean;
  disabled?: boolean;
}

export interface CommandBarRowPresentation {
  glyph: string;
  label: string;
  trailing: string;
  selected: boolean;
  primaryMuted: boolean;
  trailingAccent: boolean;
}

export function resolveCommandBarMode(query: string, commandList?: Command[]): CommandBarModeInfo {
  const match = matchPrefix(query, commandList);

  if (!query.trim()) {
    return { kind: "default", badge: "BROWSE", hint: t("Type a command or prefix") };
  }

  if (!match) {
    return { kind: "default", badge: "FILTER", hint: tf('Filtering for "{query}"', { query: query.trim() }) };
  }

  switch (match.command.id) {
    case "security-description":
      return { kind: "search", badge: match.prefix, hint: t("Open security details for a ticker") };
    case "theme":
      return { kind: "themes", badge: "THEMES", hint: t("Preview with arrows, Enter to save, Esc to revert") };
    case "layout":
      return { kind: "layout", badge: "LAYOUT", hint: t("Organize panes, history, and saved layouts") };
    default:
      return { kind: "direct-command", badge: "COMMAND", hint: tf("Run {label}", { label: t(match.command.label) }) };
  }
}

/**
 * A section whose every row is disabled or unselectable is an offer, not an
 * answer, so it sorts below real matches however its category is prioritized:
 * past the async bands (100 to 200) and the AI's lead, short of danger (900).
 */
const OFFER_SECTION_DEMOTION = 500;

interface SectionSortableItem {
  category: string;
  disabled?: boolean;
  defaultSelectable?: boolean;
}

function isOfferOnlySection<T extends SectionSortableItem>(items: T[]): boolean {
  return items.length > 0
    && items.every((item) => item.disabled === true || item.defaultSelectable === false);
}

export function buildSections<T extends SectionSortableItem>(
  items: T[],
  options?: CommandBarSectionOptions,
): Array<CommandBarSection<T>> {
  const sections: Array<CommandBarSection<T>> = [];
  for (const item of items) {
    let section = sections.find((candidate) => candidate.category === item.category);
    if (!section) {
      section = { category: item.category, items: [] };
      sections.push(section);
    }
    section.items.push(item);
  }
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => {
      const leftPriority = getCategoryPriority(a.section.category, options)
        + (isOfferOnlySection(a.section.items) ? OFFER_SECTION_DEMOTION : 0);
      const rightPriority = getCategoryPriority(b.section.category, options)
        + (isOfferOnlySection(b.section.items) ? OFFER_SECTION_DEMOTION : 0);
      const priorityDiff = leftPriority - rightPriority;
      return priorityDiff !== 0 ? priorityDiff : a.index - b.index;
    })
    .map(({ section }) => section);
}

export function getEmptyState(mode: CommandBarMode, query: string, searchQuery?: string): { label: string; detail: string } {
  switch (mode) {
    case "search":
      if (!searchQuery) {
        return { label: t("Type a ticker symbol"), detail: t("Open security details after resolving a ticker") };
      }
      return { label: tf('No matches for "{query}"', { query: searchQuery }), detail: t("Try a symbol, company name, or exchange variant") };
    case "themes":
      return { label: t("No themes match"), detail: query.trim() || t("Installed themes will appear here") };
    case "layout":
      return { label: t("No layout actions match"), detail: query.trim() || t("Focused-pane and layout actions will appear here") };
    default:
      if (query.trim()) {
        return { label: tf('No matches for "{query}"', { query: query.trim() }), detail: t("Try a command name or prefix. Use T for ticker search") };
      }
      return { label: t("No results yet"), detail: t("Suggested commands will appear here") };
  }
}

export function getRowPresentation(item: CommandBarItemView, selected: boolean, showTrailing: boolean): CommandBarRowPresentation {
  const glyph = selected ? "\u203a" : " ";
  const primaryMuted = (item.kind === "plugin" && !item.checked) || item.disabled === true;
  let trailing = "";

  if (showTrailing) {
    if (item.current) trailing = "current";
    else if (item.kind === "plugin") trailing = item.checked ? "on" : "off";
    else trailing = item.right || "";
  }

  return {
    glyph,
    label: t(item.label),
    trailing: t(trailing),
    selected,
    primaryMuted,
    trailingAccent: item.accent === true && trailing.length > 0,
  };
}

export function truncateText(text: string, width: number): string {
  return truncateToDisplayWidth(text, width);
}

/**
 * An exactly matching symbol is the most certain answer the terminal has, so
 * nothing outranks it. Typing "sive" put the AI's "DES SIVE" above the SIVE row
 * it was derived from, which is a guess sitting above the fact behind it.
 */
const EXACT_MATCH_SECTION_PRIORITY = -150;
/**
 * The AI leads the rest even though it is the slowest source (~600ms+): it
 * translates the sentence the user typed into commands, which is the answer to
 * what they asked when no symbol matched outright. Its Thinking placeholder
 * reserves the rows from the start, so the arrival replaces a row instead of
 * shifting the list.
 */
const ASSIST_SECTION_PRIORITY = -100;
/**
 * The other async sections sit below the local matches in arrival order, so
 * each answer only ever pushes rows below itself: instruments in the 100s,
 * documents at 200 (contributed by the provider).
 */
const INSTRUMENTS_SECTION_PRIORITY = 100;

function getCategoryPriority(category: string, options?: CommandBarSectionOptions): number {
  const contributed = options?.categoryPriorities?.get(category);
  if (contributed !== undefined) return contributed;
  const sectionOrder = options?.sectionOrder ?? "default";
  const normalized = category.trim().toLowerCase();
  if (sectionOrder === "ranked") return 0;
  if (normalized === "ask ai") return ASSIST_SECTION_PRIORITY;
  if (normalized === "exact match") return EXACT_MATCH_SECTION_PRIORITY;
  if (normalized === "instruments") return INSTRUMENTS_SECTION_PRIORITY;
  if (sectionOrder === "app-first") {
    if (normalized === "saved") return 100;
    if (normalized === "primary listing") return 110;
    if (normalized === "other listings") return 120;
    if (normalized === "funds & derivatives") return 130;
  }
  if (normalized === "saved") return -40;
  if (normalized === "primary listing") return -30;
  if (normalized === "other listings") return -20;
  if (normalized === "funds & derivatives") return -10;
  if (normalized.includes("danger")) return 900;
  if (normalized.includes("debug")) return 910;
  return 0;
}
