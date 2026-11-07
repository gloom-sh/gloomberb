import { describe, expect, test } from "bun:test";
import { join } from "path";
import type { ChangelogRelease } from "../../../updater/github-releases";
import {
  groupChangelogVersions,
  HIGHLIGHTS_MAX,
  nextChangelogVersionSort,
  parseVersionSummaries,
  sortChangelogVersions,
  topHighlight,
  versionOfRelease,
} from "./versions";

function release(tag: string, body = "", publishedAt = "2026-11-03T10:00:00Z"): ChangelogRelease {
  return { id: tag, tagName: tag, version: tag, title: `Title of ${tag}`, body, publishedAt, url: "" };
}

describe("parseVersionSummaries", () => {
  test("reads each version's title and highlights with the updates they name, and skips the rest", () => {
    const summaries = parseVersionSummaries([
      "# Changelog",
      "",
      "Intro, with a [link](https://example.com).",
      "<!--",
      "## 0.99: An example in the format notes",
      "- **Example.** Line. (0.99.0)",
      "-->",
      "## 0.20: A, B, and C",
      "",
      "- **Faster `DES`.** It starts sooner. (v0.20.0 ,0.20.2 )",
      "  ![HM](https://gloom.sh/screenshots/fn/HM.png)",
      "* A claim without a bold lead (0.20.1)",
      "- **No update named.** Kept.",
      "Stray paragraph.",
      "## 0.19",
      "- **Untitled version.** (0.19.0)",
      "### A subheading ends the section",
      "- **Not 0.19's.** (0.19.1)",
      "## 0.20: A repeated section does not replace the first",
    ].join("\r\n"));

    expect([...summaries.keys()]).toEqual(["0.20", "0.19"]);
    expect(summaries.get("0.20")).toEqual({
      minor: "0.20",
      title: "A, B, and C",
      highlights: [
        { lead: "Faster `DES`.", detail: "It starts sooner.", versions: ["0.20.0", "0.20.2"] },
        { lead: "A claim without a bold lead", detail: "", versions: ["0.20.1"] },
        { lead: "No update named.", detail: "Kept.", versions: [] },
      ],
    });
    expect(summaries.get("0.19")).toEqual({
      minor: "0.19",
      title: null,
      highlights: [{ lead: "Untitled version.", detail: "", versions: ["0.19.0"] }],
    });
    expect(parseVersionSummaries(null).size).toBe(0);
    expect(parseVersionSummaries("<!--\n## 0.20: Hidden").size).toBe(0);
  });

  test("the repository's own CHANGELOG.md gives each version a title and 3 to 5 highlights, each naming updates of that version", async () => {
    const markdown = await Bun.file(join(import.meta.dir, "../../../../CHANGELOG.md")).text();
    const summaries = parseVersionSummaries(markdown);

    expect(summaries.size).toBeGreaterThan(0);
    for (const [minor, summary] of summaries) {
      expect(summary.title, `## ${minor} has a title`).toBeTruthy();
      expect(summary.highlights.length, `## ${minor} has 3 to 5 highlights`).toBeGreaterThanOrEqual(3);
      expect(summary.highlights.length).toBeLessThanOrEqual(HIGHLIGHTS_MAX);
      for (const highlight of summary.highlights) {
        expect(highlight.detail, `"${highlight.lead}" has a line after its claim`).not.toBe("");
        expect(highlight.versions.length, `"${highlight.lead}" names its updates`).toBeGreaterThan(0);
        for (const version of highlight.versions) expect(version.startsWith(`${minor}.`), `${version} is a ${minor} update`).toBe(true);
      }
    }
  });
});

describe("groupChangelogVersions", () => {
  test("one version per minor, newest first, filling what a summary leaves out from its updates", () => {
    const releases = [
      release("v0.20.1", "## Highlights\n\n- **One.** More. (#2)", "2026-11-04T10:00:00Z"),
      release("v0.20.0", "- **Zero.** More. (#1)", "2026-11-03T10:00:00Z"),
      release("v0.19.0", "- Intel Macs have an install: `curl a | bash` works. Next. (#9)", "2026-10-28T10:00:00Z"),
      release("v0.18.0", "No bullets at all.", "2026-10-19T10:00:00Z"),
    ];
    const versions = groupChangelogVersions(releases, parseVersionSummaries("## 0.20\n"));

    expect(versions.map((version) => [version.id, version.title, version.highlights.map((highlight) => highlight.lead), version.releases.length])).toEqual([
      ["v0.20", "Title of v0.20.0", ["Zero.", "One."], 2],
      ["v0.19", "Title of v0.19.0", ["Intel Macs have an install."], 1],
      ["v0.18", "Title of v0.18.0", ["Title of v0.18.0"], 1],
    ]);
    expect(versions[0]).toMatchObject({ firstPublishedAt: "2026-11-03T10:00:00Z", lastPublishedAt: "2026-11-04T10:00:00Z" });
    expect(versionOfRelease(versions, "v0.20.0")?.id).toBe("v0.20");
    // A list cut at its limit leaves its oldest version, maybe missing updates, out.
    expect(groupChangelogVersions(releases, new Map(), { cut: true }).map((version) => version.id)).toEqual(["v0.20", "v0.19"]);
  });

  test("a plain bullet's claim stops at its first sentence or colon, never inside code", () => {
    expect(topHighlight(release("v0.13.1", "- Open `x.y` in your browser. Then more. (#3, #4)")).lead).toBe("Open `x.y` in your browser.");
  });
});

describe("version sort", () => {
  test("sorts versions by number, not text, and by how many updates they had", () => {
    const versions = groupChangelogVersions([release("v0.9.0"), release("v0.10.1"), release("v0.10.0")], new Map());

    expect(sortChangelogVersions(versions, { columnId: "version", direction: "asc" }).map((version) => version.id)).toEqual(["v0.9", "v0.10"]);
    expect(sortChangelogVersions(versions, { columnId: "updates", direction: "desc" }).map((version) => version.id)).toEqual(["v0.10", "v0.9"]);
    expect(nextChangelogVersionSort({ columnId: "date", direction: "desc" }, "title")).toEqual({ columnId: "title", direction: "asc" });
    expect(nextChangelogVersionSort({ columnId: "date", direction: "desc" }, "missing")).toEqual({ columnId: "date", direction: "desc" });
  });
});
