const GLOOMBERB_REPO = "gloom-sh/gloomberb";
const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GLOOMBERB_REPO}/releases`;
export const GITHUB_LATEST_RELEASE_API_URL = `${GITHUB_RELEASES_API_URL}/latest`;

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

export async function fetchChangelogReleases(
  limit = 30,
  signal?: AbortSignal,
): Promise<ChangelogRelease[]> {
  const perPage = Math.max(1, Math.min(Math.floor(limit), 100));
  const response = await fetch(`${GITHUB_RELEASES_API_URL}?per_page=${perPage}`, {
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

  return data
    .map((release) => normalizeChangelogRelease(release as GitHubReleasePayload))
    .filter((release): release is ChangelogRelease => release !== null);
}
