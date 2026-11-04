import { ADR_PAIR_TAB_ID } from "./adr-pair/model";

/** What the grouping reads of a research tab. */
export interface TickerResearchTabSummary {
  id: string;
  name: string;
  order: number;
}

interface TickerResearchGroupDef {
  id: string;
  name: string;
  /** Research tab ids, in the order the group offers them. */
  views: readonly string[];
}

/**
 * Ticker Research's top strip, in order. Each group offers its views as
 * choices under the strip; a view is still known by its own tab id everywhere
 * else (saved layouts, a locked pane, `?tab=`, `--tab`, links between tabs,
 * the views people stay on), so the grouping is only how the strip reads.
 *
 * Trade is Chart with the ticket beside it, and closing the ticket goes back
 * to Chart (`ResearchTradeWorkspace`), so it is Chart's second view. ADR vs
 * Home, the receipt's price against its home line, is the last of
 * Financials. Both show only for some tickers, so each comes after the views
 * every ticker has. A plugin's own tab is in no group: it gets its own top
 * tab after these (`groupTickerResearchTabs`).
 */
const TICKER_RESEARCH_GROUPS: readonly TickerResearchGroupDef[] = [
  { id: "overview", name: "Overview", views: ["overview"] },
  { id: "chart", name: "Chart", views: ["chart", "broker-trade"] },
  { id: "financials", name: "Financials", views: ["financials", "revenue", "equity-diagnostic", "dividend-yield", ADR_PAIR_TAB_ID] },
  { id: "analysts", name: "Analysts", views: ["analyst-research", "earnings-calls"] },
  { id: "options", name: "Options", views: ["options"] },
  { id: "events", name: "Events", views: ["corporate-actions", "catalysts", "mna"] },
  { id: "filings", name: "Filings", views: ["sec", "filing-events", "risk-factors"] },
  { id: "ownership", name: "Ownership", views: ["holders", "insider", "thirteenf", "congress", "short-interest"] },
  { id: "people", name: "People", views: ["executives", "jobs", "hiring-momentum"] },
  { id: "buzz", name: "Buzz", views: ["news", "ticker-tweets", "app-attention"] },
  { id: "notes", name: "Notes", views: ["thesis", "notes"] },
];

/** One top tab: a group with the views this ticker has, or a view of its own. */
export interface TickerResearchTabGroup {
  id: string;
  name: string;
  /** At least one; with more, the group shows them as choices. */
  views: TickerResearchTabSummary[];
}

/** A plugin's tab id, kept apart from the group ids. */
const OWN_GROUP_PREFIX = "tab:";

/**
 * The top tabs for the views a ticker has (`buildVisibleTickerResearchTabs`):
 * a group with none of them is left out, and a plugin's tab that belongs to
 * no group is a top tab of its own after the built-in ones, by its `order`.
 */
export function groupTickerResearchTabs(tabs: readonly TickerResearchTabSummary[]): TickerResearchTabGroup[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const grouped = new Set<string>();
  const groups: TickerResearchTabGroup[] = [];
  for (const group of TICKER_RESEARCH_GROUPS) {
    const views = group.views.flatMap((id) => byId.get(id) ?? []);
    for (const view of views) grouped.add(view.id);
    if (views.length > 0) groups.push({ id: group.id, name: group.name, views });
  }
  const own = tabs.filter((tab) => !grouped.has(tab.id)).sort((left, right) => left.order - right.order);
  for (const tab of own) groups.push({ id: `${OWN_GROUP_PREFIX}${tab.id}`, name: tab.name, views: [tab] });
  return groups;
}

/** The group a view is shown in. */
export function findTickerResearchGroup(groups: readonly TickerResearchTabGroup[], viewId: string): TickerResearchTabGroup | undefined {
  return groups.find((group) => group.views.some((view) => view.id === viewId));
}

/** The view a group opens on: the one last chosen in it while it is there, else its first. */
export function tickerResearchGroupView(group: TickerResearchTabGroup, remembered: string | undefined): string {
  return (remembered && group.views.some((view) => view.id === remembered) ? remembered : group.views[0]!.id);
}
