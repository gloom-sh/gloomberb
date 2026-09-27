import type { ChangelogRelease } from "../../../updater/github-releases";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";

export type ChangelogColumnId = "date" | "version" | "title";

export interface ChangelogSortPreference {
  columnId: ChangelogColumnId;
  direction: SortDirection;
}

export const DEFAULT_CHANGELOG_SORT: ChangelogSortPreference = {
  columnId: "date",
  direction: "desc",
};

function isChangelogColumnId(columnId: string): columnId is ChangelogColumnId {
  return columnId === "date" || columnId === "version" || columnId === "title";
}

function defaultDirection(columnId: ChangelogColumnId): SortDirection {
  return columnId === "title" ? "asc" : "desc";
}

function releaseDateValue(release: ChangelogRelease): number {
  const timestamp = Date.parse(release.publishedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareReleaseValue(
  left: ChangelogRelease,
  right: ChangelogRelease,
  columnId: ChangelogColumnId,
): number {
  switch (columnId) {
    case "date":
      return releaseDateValue(left) - releaseDateValue(right);
    case "version":
      return compareText(left.version, right.version);
    case "title":
      return compareText(left.title, right.title);
  }
}

export function sortChangelogReleases(
  releases: ChangelogRelease[],
  sortPreference: ChangelogSortPreference,
): ChangelogRelease[] {
  return releases
    .map((release, index) => ({ release, index }))
    .sort((left, right) => {
      const comparison = compareReleaseValue(
        left.release,
        right.release,
        sortPreference.columnId,
      );
      const directed = sortPreference.direction === "asc"
        ? comparison
        : -comparison;
      return directed || left.index - right.index;
    })
    .map((entry) => entry.release);
}

export function nextChangelogSortPreference(
  current: ChangelogSortPreference,
  columnId: string,
): ChangelogSortPreference {
  if (!isChangelogColumnId(columnId)) return current;
  return nextHeaderSort(current, columnId, { firstDirection: defaultDirection });
}

export function resolveSelectedReleaseIndex(
  releases: ChangelogRelease[],
  selectedReleaseId: string | null,
): number {
  const selectedIndex = selectedReleaseId
    ? releases.findIndex((release) => release.id === selectedReleaseId)
    : -1;
  if (selectedIndex >= 0) return selectedIndex;
  return releases.length > 0 ? 0 : -1;
}
