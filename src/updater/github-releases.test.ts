import { describe, expect, test } from "bun:test";
import { normalizeChangelogRelease } from "./github-releases";

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
