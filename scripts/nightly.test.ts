import { describe, expect, test } from "bun:test";
import { compareSemver } from "../src/utils/semver";
import {
  isNightlyTag,
  leftoverDrafts,
  nightlyBaseVersion,
  nightlyVersion,
  planNightly,
  prunableNightlies,
  readLatestStableTag,
  type NightlyPlanInput,
} from "./nightly";

describe("nightly versions", () => {
  test("count up from the patch after the latest stable release, so they sort above it", () => {
    // main's package.json is the release it was tagged as.
    expect(nightlyBaseVersion("0.17.4", "v0.17.4")).toBe("0.17.5");
    // Bumped on main but not released yet: count up from there.
    expect(nightlyBaseVersion("0.18.0", "v0.17.4")).toBe("0.18.0");
    expect(() => nightlyBaseVersion("0.17.5-nightly.1", "v0.17.4")).toThrow();
  });

  // Falling back to package.json would build 0.16.4-nightly.*, below the
  // stable 0.16.4 everyone already runs.
  test("fail the plan when the latest stable release cannot be read", async () => {
    const repo = "gloom-sh/gloomberb";
    await expect(readLatestStableTag(repo, async () => { throw new Error("HTTP 502"); }))
      .rejects.toThrow("Could not read the latest stable release, so there is no version to build: HTTP 502");
    await expect(readLatestStableTag(repo, async () => "\n")).rejects.toThrow("is not a stable version");
    await expect(readLatestStableTag(repo, async () => "v0.17.5-nightly.20261016.5.gabcdef0\n")).rejects.toThrow("is not a stable version");
    await expect(readLatestStableTag(repo, async () => "v0.17.4\n")).resolves.toBe("v0.17.4");
    expect(() => nightlyBaseVersion("0.16.4", "")).toThrow("is not a release version");
  });

  test("order by day, then by run, whatever the sha, between the stable releases around them", () => {
    const sha = (hex: string) => hex.repeat(40).slice(0, 40);
    const morning = nightlyVersion("0.17.5", new Date("2026-10-15T03:00:00Z"), 9, sha("f"));
    const evening = nightlyVersion("0.17.5", new Date("2026-10-15T21:00:00Z"), 10, sha("0"));
    const nextDay = nightlyVersion("0.17.5", new Date("2026-10-16T03:00:00Z"), 11, sha("1234567"));

    expect(morning).toBe("0.17.5-nightly.20261015.9.gfffffff");
    expect(nextDay).toBe("0.17.5-nightly.20261016.11.g1234567");
    expect(isNightlyTag(`v${nextDay}`)).toBe(true);
    const ordered = ["0.17.4", morning, evening, nextDay, "0.17.5"];
    expect([...ordered].reverse().sort((a, b) => compareSemver(a, b) ?? 0)).toEqual(ordered);
  });
});

describe("planNightly", () => {
  const base: NightlyPlanInput = {
    event: "schedule",
    publish: true,
    force: false,
    onMain: true,
    sha: "a".repeat(40),
    previousSha: "b".repeat(40),
    verifyPassed: true,
    verifyWindowsPassed: true,
  };

  test("publishes a new main commit once Verify and Verify Windows passed on it", () => {
    expect(planNightly(base)).toMatchObject({ build: true, publish: true });
  });

  test("skips when main has not moved, unless forced", () => {
    expect(planNightly({ ...base, previousSha: base.sha })).toMatchObject({ build: false });
    expect(planNightly({ ...base, previousSha: base.sha, force: true })).toMatchObject({ build: true });
  });

  test("never publishes a commit the checks have not passed, and fails a manual run that asks", () => {
    expect(planNightly({ ...base, verifyWindowsPassed: false })).toEqual({
      build: false,
      publish: false,
      reason: "Verify Windows has not passed on aaaaaaa",
    });
    expect(planNightly({ ...base, event: "workflow_dispatch", verifyPassed: false }).error).toContain("Verify has not passed");
    // A build-only run does not need them.
    expect(planNightly({ ...base, publish: false, verifyPassed: false })).toMatchObject({ build: true, publish: false });
  });

  test("publishes only from main", () => {
    expect(planNightly({ ...base, onMain: false }).error).toBeDefined();
    expect(planNightly({ ...base, onMain: false, publish: false })).toMatchObject({ build: true, publish: false });
  });
});

describe("prunableNightlies", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const old = "2026-10-01T00:00:00Z";
  let id = 0;
  const release = (tag_name: string, fields: { prerelease?: boolean; draft?: boolean; published_at?: string | null } = {}) => ({
    id: ++id,
    tag_name,
    prerelease: true,
    draft: false,
    published_at: old,
    ...fields,
  });

  test("lists only published nightly prereleases past the cutoff, never a stable release or the newest build", () => {
    const releases = [
      release("v0.17.5-nightly.20261001.3.gabcdef0"),
      release("v0.17.6-nightly.20261031.9.g1234567", { published_at: "2026-10-31T00:00:00Z" }),
      release("v0.17.4", { prerelease: false }),
      // Flagged prerelease but not a nightly tag, or a nightly tag GitHub does not flag: left alone.
      release("v0.5.0"),
      release("v0.17.5-nightly.20261002.4.gabcdef1", { prerelease: false }),
      // A draft, and a release with no publish date.
      release("v0.17.5-nightly.20261004.6.gabcdef3", { draft: true }),
      release("v0.17.5-nightly.20261005.7.gabcdef4", { published_at: null }),
      // This run's own build.
      release("v0.17.5-nightly.20261003.5.gabcdef2"),
    ];

    expect(prunableNightlies(releases, now, 14, "v0.17.5-nightly.20261003.5.gabcdef2")).toEqual([
      "v0.17.5-nightly.20261001.3.gabcdef0",
    ]);
  });

  test("goes by when a build was published, not its commit's date", () => {
    // GitHub sets created_at from the tagged commit: an old commit built yesterday is not old.
    const releases = [
      { ...release("v0.17.5-nightly.20261031.8.gabcdef0", { published_at: "2026-10-31T04:40:00Z" }), created_at: old },
      release("v0.17.6-nightly.20261101.9.g1234567", { published_at: "2026-11-01T04:40:00Z" }),
    ];
    expect(prunableNightlies(releases, now, 14, null)).toEqual([]);
  });

  test("never lists the newest nightly build, even past the cutoff", () => {
    const releases = [release("v0.17.5-nightly.20261001.3.gabcdef0"), release("v0.17.5-nightly.20261002.4.gabcdef1")];
    expect(prunableNightlies(releases, now, 14, null)).toEqual(["v0.17.5-nightly.20261001.3.gabcdef0"]);
  });
});

describe("leftoverDrafts", () => {
  const tag = "v0.17.5-nightly.20261016.12.gabcdef0";
  const listing = (id: number, tag_name: string, draft: boolean) => ({ id, tag_name, draft, prerelease: true, published_at: draft ? null : "2026-10-16T05:00:00Z" });

  test("lists this run's drafts only, never a published release or another tag", () => {
    expect(leftoverDrafts([
      listing(1, tag, true),
      listing(2, tag, false),
      listing(3, "v0.17.5-nightly.20261015.11.g1234567", true),
      { id: 4, tag_name: "v0.17.4", draft: true, prerelease: false, published_at: null },
    ], tag)).toEqual([1]);
  });

  test("refuses a tag that is not a nightly build's", () => {
    expect(() => leftoverDrafts([], "v0.17.4")).toThrow("is not a nightly tag");
  });
});
