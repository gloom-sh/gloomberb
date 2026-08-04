import { matchPrefix, type Command } from "./commands/registry";
import { t, tf } from "../../i18n";
import { truncateToDisplayWidth } from "../../utils/format";

export { rankTickerSearchItems } from "../../tickers/search";

export type CommandBarMode = "default" | "search" | "themes" | "plugins" | "layout" | "direct-command";

export interface CommandBarModeInfo {
  kind: CommandBarMode;
  badge: string;
  hint: string;
}

export interface CommandBarSection<T> {
  category: string;
  items: T[];
}

export type CommandBarSectionOrder = "default" | "app-first";

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
    case "plugins":
      return { kind: "plugins", badge: "PLUGINS", hint: t("Toggle plugins without leaving the list") };
    case "layout":
      return { kind: "layout", badge: "LAYOUT", hint: t("Organize panes, history, and saved layouts") };
    default:
      return { kind: "direct-command", badge: "COMMAND", hint: tf("Run {label}", { label: t(match.command.label) }) };
  }
}

export function buildSections<T extends { category: string }>(
  items: T[],
  options?: { sectionOrder?: CommandBarSectionOrder },
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
      const leftPriority = getCategoryPriority(a.section.category, options?.sectionOrder);
      const rightPriority = getCategoryPriority(b.section.category, options?.sectionOrder);
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
    case "plugins":
      return { label: t("No plugins match"), detail: query.trim() || t("Toggleable plugins will appear here") };
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

function getCategoryPriority(category: string, sectionOrder: CommandBarSectionOrder = "default"): number {
  const normalized = category.trim().toLowerCase();
  if (normalized === "exact match") return -50;
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
  // The AI fallback is always the last resort, below even the danger zone.
  if (normalized === "ask ai") return 999;
  return 0;
}
