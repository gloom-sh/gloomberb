import { afterEach, describe, expect, test } from "bun:test";
import { fetchChangelogReleases, normalizeChangelogRelease } from "./github-releases";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("normalizeChangelogRelease", () => {
  test("maps a GitHub release into changelog row fields", () => {
    const release = normalizeChangelogRelease({
      id: 75,
      tag_name: "v0.7.5",
      name: "v0.7.5 - Crash recovery and ticker opens",
      published_at: "2026-05-14T23:27:47Z",
      body: "## Highlights\n\n- Fixed startup recovery.",
      html_url: "https://github.com/gloom-sh/gloomberb/releases/tag/v0.7.5",
    });

    expect(release).toEqual({
      id: "75",
      tagName: "v0.7.5",
      version: "v0.7.5",
      title: "Crash recovery and ticker opens",
      publishedAt: "2026-05-14T23:27:47Z",
      body: "## Highlights\n\n- Fixed startup recovery.",
      url: "https://github.com/gloom-sh/gloomberb/releases/tag/v0.7.5",
    });
  });

  test("falls back to the tag page and a default body", () => {
    const release = normalizeChangelogRelease({
      tag_name: "v1.0.0",
      name: "v1.0.0",
    });

    expect(release?.id).toBe("v1.0.0");
    expect(release?.title).toBe("v1.0.0");
    expect(release?.body).toBe("No changelog details were published for this release.");
    expect(release?.url).toBe("https://github.com/gloom-sh/gloomberb/releases/tag/v1.0.0");
  });

  test("drops malformed releases without a tag", () => {
    expect(normalizeChangelogRelease({ name: "Missing tag" })).toBeNull();
  });
});

describe("fetchChangelogReleases", () => {
  test("lists stable releases only, reading on while nightly builds fill a page", async () => {
    const nightly = (day: number) => ({ id: day, tag_name: `v0.17.5-nightly.202610${day}.${day}.gabc1234`, prerelease: true });
    // Two stable releases wanted: a page holds 22, and 21 of the first are nightly builds.
    const pages = [
      [...Array.from({ length: 20 }, (_, index) => nightly(index + 10)), { id: 2, tag_name: "v0.17.4" }, { id: 90, tag_name: "v0.17.4-rc.1" }],
      [{ id: 91, tag_name: "v0.17.3", prerelease: true }, { id: 1, tag_name: "v0.17.2" }],
    ];
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    }) as typeof fetch;

    const releases = await fetchChangelogReleases(2);

    // A tag with a prerelease part and a release GitHub flags as one are both left out.
    expect(releases.map((release) => release.tagName)).toEqual(["v0.17.4", "v0.17.2"]);
    expect(requested).toEqual([
      "https://api.github.com/repos/gloom-sh/gloomberb/releases?per_page=22&page=1",
      "https://api.github.com/repos/gloom-sh/gloomberb/releases?per_page=22&page=2",
    ]);
  });
});
