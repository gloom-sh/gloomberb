import type { TeamSummary } from "../../api-client";
import type { SavedLayout } from "../../types/config";
import type { TeamStoreSnapshot } from "../../plugins/builtin/cloud/team/store";

export type TabGroupId = "personal" | `team:${string}`;

export interface StatusBarTabGroup {
  id: TabGroupId;
  team: TeamSummary | null;
  /** Indexes into config.layouts, in tab order. */
  indexes: number[];
  collapsed: boolean;
}

const GROUP_MARKER_PREFIX = "group:";

export function groupIdFor(layout: Pick<SavedLayout, "origin">): TabGroupId {
  return layout.origin ? `team:${layout.origin.teamId}` : "personal";
}

/**
 * What FOCUS says about a group before any manual toggle: personal focus
 * folds every team, a team focus folds everything but that team, all folds
 * nothing.
 */
export function focusCollapses(focus: TeamStoreSnapshot["focus"], groupId: TabGroupId): boolean {
  if (focus === "all") return false;
  if (focus === "personal") return groupId !== "personal";
  return groupId !== `team:${focus.teamId}`;
}

/**
 * Splits the tab strip into a personal group and one per team, in team name
 * order, keeping `Ctrl+1-9` positional because indexes are carried through.
 * A group with the active tab is never collapsed: switching into it opens it.
 */
export function buildStatusBarTabGroups(
  layouts: readonly Pick<SavedLayout, "origin">[],
  activeIndex: number,
  teams: readonly TeamSummary[],
  focus: TeamStoreSnapshot["focus"],
  manualToggles: ReadonlySet<string>,
): StatusBarTabGroup[] {
  const personal: number[] = [];
  const byTeam = new Map<string, number[]>();
  layouts.forEach((layout, index) => {
    if (!layout.origin) {
      personal.push(index);
      return;
    }
    const list = byTeam.get(layout.origin.teamId) ?? [];
    list.push(index);
    byTeam.set(layout.origin.teamId, list);
  });
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const teamGroups = [...byTeam.entries()]
    .map(([teamId, indexes]) => ({ teamId, team: teamById.get(teamId) ?? null, indexes }))
    // Known teams by name; teams the store has not loaded yet go last.
    .sort((a, b) => (
      a.team && b.team
        ? a.team.name.localeCompare(b.team.name)
        : a.team ? -1 : b.team ? 1 : a.teamId.localeCompare(b.teamId)
    ));

  const groups: StatusBarTabGroup[] = [];
  const push = (id: TabGroupId, team: TeamSummary | null, indexes: number[]) => {
    if (indexes.length === 0) return;
    const byFocus = focusCollapses(focus, id);
    const collapsed = manualToggles.has(id) ? !byFocus : byFocus;
    groups.push({ id, team, indexes, collapsed: collapsed && !indexes.includes(activeIndex) });
  };
  push("personal", null, personal);
  for (const group of teamGroups) push(`team:${group.teamId}`, group.team, group.indexes);
  return groups;
}

export function groupMarkerValue(groupId: TabGroupId): string {
  return `${GROUP_MARKER_PREFIX}${groupId}`;
}

export function groupIdFromMarkerValue(value: string): TabGroupId | null {
  if (!value.startsWith(GROUP_MARKER_PREFIX)) return null;
  const id = value.slice(GROUP_MARKER_PREFIX.length);
  return id === "personal" || id.startsWith("team:") ? (id as TabGroupId) : null;
}
