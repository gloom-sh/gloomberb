import { compareSemver, isPrereleaseVersion, parseSemver } from "../utils/semver";

const GLOOMBERB_REPO = "gloom-sh/gloomberb";
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GLOOMBERB_REPO}/releases`;
/** GitHub's newest release that is neither a draft nor a prerelease: the stable channel. */
export const GITHUB_LATEST_RELEASE_API_URL = `${GITHUB_RELEASES_API_URL}/latest`;
/** Where one release's assets download from, by tag. */
export function githubReleaseDownloadBaseUrl(tagName: string): string {
  return `https://github.com/${GLOOMBERB_REPO}/releases/download/${encodeURIComponent(tagName)}`;
}

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  /** `sha256:<hex>`, which GitHub computes for every uploaded asset. */
  digest?: string;
}

/** The fields the updater reads from GitHub's release list. */
export interface GitHubReleaseListing {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  assets?: GitHubReleaseAsset[];
}

/**
 * A nightly build or another prerelease: GitHub's prerelease flag, or a tag
 * with a prerelease part (`v0.17.5-nightly.20261015.42.gabc1234`). Changelogs
 * leave these out; only the nightly update channel installs them.
 */
export function isPrereleaseRelease(release: Pick<GitHubReleaseListing, "tag_name" | "prerelease">): boolean {
  return release.prerelease === true || isPrereleaseVersion(release.tag_name);
}

/**
 * The highest version among published releases that `usable` accepts
 * (drafts and tags that are not versions never count), by semver rather than
 * by date: a stable release that passed a nightly's version wins over it.
 */
export function newestRelease<T extends GitHubReleaseListing>(
  releases: readonly T[],
  usable: (release: T) => boolean = () => true,
): T | null {
  let newest: T | null = null;
  for (const release of releases) {
    if (release.draft === true || !parseSemver(release.tag_name)) continue;
    if (!usable(release)) continue;
    if (!newest || (compareSemver(release.tag_name, newest.tag_name) ?? 0) > 0) newest = release;
  }
  return newest;
}

export interface ChangelogRelease {
  id: string;
  tagName: string;
  version: string;
  title: string;
  body: string;
  publishedAt: string;
  url: string;
}

interface GitHubReleasePayload {
  id?: number | string;
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  html_url?: string | null;
}

const DEFAULT_CHANGELOG_BODY = "No changelog details were published for this release.";

function stripTagPrefix(name: string, tagName: string): string {
  if (!tagName) return name;
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`^${escapedTag}\\s*(?:-|:)\\s*`, "i"), "").trim();
}

export function normalizeChangelogRelease(release: GitHubReleasePayload): ChangelogRelease | null {
  const tagName = release.tag_name?.trim();
  if (!tagName) return null;

  const rawName = release.name?.trim() || "";
  const title = stripTagPrefix(rawName, tagName) || rawName || tagName;
  const body = release.body?.trim() || DEFAULT_CHANGELOG_BODY;

  return {
    id: String(release.id ?? tagName),
    tagName,
    version: tagName,
    title,
    body,
    publishedAt: release.published_at ?? "",
    url: release.html_url?.trim() || `https://github.com/${GLOOMBERB_REPO}/releases/tag/${encodeURIComponent(tagName)}`,
  };
}

/** Nightly builds a page of the release list may hold besides the stable releases asked for. */
const CHANGELOG_PRERELEASE_ROOM = 20;
const CHANGELOG_MAX_PAGES = 3;

/**
 * The newest stable releases, up to `limit`. Nightly builds and other
 * prereleases are left out, and the list reads further pages while they crowd
 * one out.
 */
export async function fetchChangelogReleases(
  limit = 30,
  signal?: AbortSignal,
): Promise<ChangelogRelease[]> {
  const wanted = Math.max(1, Math.floor(limit));
  const perPage = Math.min(wanted + CHANGELOG_PRERELEASE_ROOM, 100);
  const releases: ChangelogRelease[] = [];

  for (let page = 1; page <= CHANGELOG_MAX_PAGES && releases.length < wanted; page += 1) {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}?per_page=${perPage}&page=${page}`, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("GitHub returned an unexpected releases payload");
    }

    for (const payload of data as Array<GitHubReleasePayload & GitHubReleaseListing>) {
      if (isPrereleaseRelease(payload)) continue;
      const release = normalizeChangelogRelease(payload);
      if (release) releases.push(release);
    }
    if (data.length < perPage) break;
  }

  return releases.slice(0, wanted);
}
