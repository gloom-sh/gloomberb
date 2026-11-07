import type { ChangelogRelease } from "../../../updater/github-releases";
import { compareSemver } from "../../../utils/semver";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";

/*
 * The Changelog by minor version: every update of 0.20 under one row, with
 * the version's title and highlights from the repository's CHANGELOG.md, or,
 * for a version it does not cover yet, from the updates' own notes. The
 * website's changelog reads the same file the same way.
 *
 * CHANGELOG.md has one section per minor version:
 *
 *   ## 0.20: A faster desktop app, broker CSV imports, and a header market
 *
 *   - **A faster, lighter desktop app.** Starts a third faster on Mac. (0.20.0)
 *     ![SCAN](https://gloom.sh/screenshots/fn/SCAN.png)
 *
 * Anything else (the title, the intro, HTML comments, other headings, the
 * pictures) is skipped here.
 */

/** Highlights shown for a version at most. */
export const HIGHLIGHTS_MAX = 5;

export interface ChangelogHighlight {
  /** The bold claim, as written: "A faster, lighter desktop app." */
  lead: string;
  /** The line after the claim (inline markdown), or "". */
  detail: string;
  /** The updates it shipped in, without the "v": "0.20.0". */
  versions: string[];
}

export interface VersionSummary {
  /** "0.20" */
  minor: string;
  title: string | null;
  highlights: ChangelogHighlight[];
}

export interface ChangelogVersion {
  /** "v0.20": a row's stable id. */
  id: string;
  /** "0.20" */
  minor: string;
  title: string;
  highlights: ChangelogHighlight[];
  /** Newest first, as GitHub lists them. */
  releases: ChangelogRelease[];
  firstPublishedAt: string;
  lastPublishedAt: string;
}

const SECTION = /^##\s+v?(\d+\.\d+)(?:\s*:\s*(.*))?$/;
const VERSIONS = /\s*\(\s*(v?\d+\.\d+\.\d+(?:\s*,\s*v?\d+\.\d+\.\d+)*)\s*\)\s*$/;
const BULLET = /^[-*]\s+(.+)$/;
const BOLD_LEAD = /^\*\*(.+?)\*\*\s*(.*)$/;
const PULL_REFS = /\s*\(\s*#\d+(?:\s*,\s*#\d+)*\s*\)\s*$/;

/** "**Claim.** Line" as its claim and its line; text without a claim is all claim. */
function splitLead(text: string): { lead: string; detail: string } {
  const match = text.match(BOLD_LEAD);
  if (match?.[1]) return { lead: match[1].trim(), detail: match[2]?.trim() ?? "" };
  return { lead: text.trim(), detail: "" };
}

export function parseVersionSummaries(markdown: string | null | undefined): Map<string, VersionSummary> {
  const summaries = new Map<string, VersionSummary>();
  if (!markdown?.trim()) return summaries;

  // HTML comments hold the format notes and an example section.
  const lines = markdown.replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/\r\n/g, "\n").split("\n");
  let current: VersionSummary | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      const section = trimmed.match(SECTION);
      current = null;
      // The newest section for a version wins over a repeated one below it.
      if (section?.[1] && !summaries.has(section[1])) {
        current = { minor: section[1], title: section[2]?.trim() || null, highlights: [] };
        summaries.set(section[1], current);
      }
      continue;
    }

    const bullet = current ? line.match(BULLET) : null;
    if (!current || !bullet?.[1]) continue;
    const text = bullet[1].trim();
    const versions = text.match(VERSIONS);
    const claim = versions ? text.slice(0, versions.index).trim() : text;
    if (!claim) continue;
    current.highlights.push({
      ...splitLead(claim),
      versions: versions?.[1] ? versions[1].split(",").map((version) => version.trim().replace(/^v/i, "")) : [],
    });
  }

  return summaries;
}

/** "v0.20.3" is 0.20; a tag that is not a version stands alone. */
export function minorOf(tagName: string): string {
  return tagName.match(/^v?(\d+\.\d+)\.\d+$/i)?.[1] ?? tagName;
}

/**
 * A plain bullet's claim: its first sentence, up to a colon that brings in
 * the details. Never inside inline code.
 */
function firstClaim(text: string): string {
  let code = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "`") code = !code;
    if (code) continue;
    const next = text[index + 1];
    if ((char === "." || char === "!" || char === "?") && (next === undefined || next === " ")) return text.slice(0, index + 1);
    if (char === ":" && next === " ") return `${text.slice(0, index)}.`;
  }
  return text;
}

/**
 * An update's top highlight: the claim of the first bullet of its notes, a
 * plain bullet's first sentence, or its title when the notes have no bullet.
 */
export function topHighlight(release: ChangelogRelease): ChangelogHighlight {
  const versions = [release.version.replace(/^v/i, "")];
  const bullet = release.body.split(/\r?\n/).map((line) => line.trim().match(BULLET)?.[1]).find(Boolean);
  if (!bullet) return { lead: release.title, detail: "", versions };
  const lead = bullet.startsWith("**") ? splitLead(bullet).lead : firstClaim(bullet.replace(PULL_REFS, ""));
  return { lead, detail: "", versions };
}

function fallbackTitle(releases: ChangelogRelease[], minor: string): string {
  const first = releases.find((release) => release.version.replace(/^v/i, "") === `${minor}.0`) ?? releases.at(-1);
  return first?.title ?? `Version ${minor}`;
}

/**
 * The releases (newest first) as one version per minor, newest first. A
 * version's title and highlights come from its summary; what the summary
 * leaves out comes from the updates themselves, so a missing or half-written
 * summary never empties a row. With `cut`, the list stopped at its limit, so
 * its oldest version may be missing updates and is left out.
 */
export function groupChangelogVersions(
  releases: ChangelogRelease[],
  summaries: Map<string, VersionSummary>,
  { cut = false }: { cut?: boolean } = {},
): ChangelogVersion[] {
  const byMinor = new Map<string, ChangelogRelease[]>();
  for (const release of releases) {
    const minor = minorOf(release.version);
    const group = byMinor.get(minor);
    if (group) group.push(release);
    else byMinor.set(minor, [release]);
  }

  const versions = [...byMinor].map(([minor, group]): ChangelogVersion => {
    const summary = summaries.get(minor);
    // Oldest first: the version's story in the order it shipped.
    const highlights = summary?.highlights.length ? summary.highlights : [...group].reverse().map(topHighlight);
    return {
      id: /^\d+\.\d+$/.test(minor) ? `v${minor}` : minor,
      minor,
      title: summary?.title ?? fallbackTitle(group, minor),
      highlights: highlights.slice(0, HIGHLIGHTS_MAX),
      releases: group,
      firstPublishedAt: group.at(-1)?.publishedAt ?? "",
      lastPublishedAt: group[0]?.publishedAt ?? "",
    };
  });
  return cut && versions.length > 1 ? versions.slice(0, -1) : versions;
}

/** The version a release belongs to, by its id, for a layout that kept an open release. */
export function versionOfRelease(versions: ChangelogVersion[], releaseId: string | null): ChangelogVersion | null {
  if (!releaseId) return null;
  return versions.find((version) => version.releases.some((release) => release.id === releaseId)) ?? null;
}

/** A version's highlights as the markdown list its detail shows, each naming its updates. */
export function highlightsMarkdown(version: ChangelogVersion): string {
  return version.highlights.map((highlight) => {
    const claim = `**${highlight.lead}**`;
    const detail = highlight.detail ? ` ${highlight.detail}` : "";
    const shipped = highlight.versions.length ? ` (${highlight.versions.join(", ")})` : "";
    return `- ${claim}${detail}${shipped}`;
  }).join("\n");
}

export type ChangelogVersionColumnId = "date" | "version" | "title" | "updates";

export interface ChangelogVersionSort {
  columnId: ChangelogVersionColumnId;
  direction: SortDirection;
}

export const DEFAULT_CHANGELOG_VERSION_SORT: ChangelogVersionSort = { columnId: "date", direction: "desc" };

function isVersionColumnId(columnId: string): columnId is ChangelogVersionColumnId {
  return columnId === "date" || columnId === "version" || columnId === "title" || columnId === "updates";
}

function dateValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareVersions(left: ChangelogVersion, right: ChangelogVersion, columnId: ChangelogVersionColumnId): number {
  switch (columnId) {
    case "date":
      return dateValue(left.lastPublishedAt) - dateValue(right.lastPublishedAt);
    case "version":
      return compareSemver(`${left.minor}.0`, `${right.minor}.0`) ?? left.minor.localeCompare(right.minor, undefined, { numeric: true });
    case "title":
      return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
    case "updates":
      return left.releases.length - right.releases.length;
  }
}

export function sortChangelogVersions(versions: ChangelogVersion[], sort: ChangelogVersionSort): ChangelogVersion[] {
  return versions
    .map((version, index) => ({ version, index }))
    .sort((left, right) => {
      const comparison = compareVersions(left.version, right.version, sort.columnId);
      return (sort.direction === "asc" ? comparison : -comparison) || left.index - right.index;
    })
    .map((entry) => entry.version);
}

export function nextChangelogVersionSort(current: ChangelogVersionSort, columnId: string): ChangelogVersionSort {
  if (!isVersionColumnId(columnId)) return current;
  return nextHeaderSort(current, columnId, { firstDirection: (id) => (id === "title" ? "asc" : "desc") });
}
