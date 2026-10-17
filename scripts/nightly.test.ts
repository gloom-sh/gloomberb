import { describe, expect, test } from "bun:test";
import { compareSemver } from "../src/utils/semver";
import {
  firstParentHistory,
  isNightlyTag,
  leftoverDrafts,
  newestVerifiedCommit,
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
  const sha = (letter: string) => letter.repeat(40);
  // main's first-parent history, newest first: "a" is the head the run started on.
  const history = ["a", "b", "c", "d", "e"].map(sha);
  const base: NightlyPlanInput = {
    event: "schedule",
    publish: true,
    force: false,
    onMain: true,
    head: sha("a"),
    history,
    previousSha: sha("e"),
    verifyPassed: history,
    verifyWindowsPassed: history,
  };

  test("publishes main's head once Verify and Verify Windows passed on it", () => {
    expect(planNightly(base)).toEqual({
      build: true,
      publish: true,
      sha: sha("a"),
      reason: "publishing aaaaaaa: main's head passed Verify and Verify Windows",
    });
  });

  // The schedule fires hours late, during the merges: the head is often still
  // being verified, and a push cancels the Verify Windows run of the one before.
  test("builds the newest commit both checks passed on when the head is not verified yet", () => {
    const plan = planNightly({
      ...base,
      // b passed Verify but its Verify Windows run was cancelled by the next push.
      verifyPassed: [sha("b"), sha("c"), sha("d")],
      verifyWindowsPassed: [sha("c"), sha("d"), sha("e")],
    });
    expect(plan).toEqual({
      build: true,
      publish: true,
      sha: sha("c"),
      reason: "publishing ccccccc: head aaaaaaa not verified yet; newest verified is ccccccc, 2 commits behind",
    });
    expect(planNightly({ ...base, verifyPassed: [sha("b")], verifyWindowsPassed: [sha("b")] }).reason).toContain("1 commit behind");
  });

  test("with no verified commit in the window, skips on schedule and fails a manual run", () => {
    const unverified = { ...base, previousSha: sha("9"), verifyPassed: [sha("9")], verifyWindowsPassed: [] };
    expect(planNightly(unverified)).toEqual({
      build: false,
      publish: false,
      sha: "",
      reason: "None of main's last 5 commits has passed Verify and Verify Windows (head aaaaaaa)",
    });
    expect(planNightly({ ...unverified, event: "workflow_dispatch" }).error).toContain("None of main's last 5 commits");
  });

  test("skips when the newest verified commit is the last nightly build's, unless forced", () => {
    const behind = { ...base, previousSha: sha("c"), verifyPassed: [sha("c")], verifyWindowsPassed: [sha("c")] };
    expect(planNightly(behind)).toMatchObject({
      build: false,
      sha: "",
      reason: "No commit after the last nightly build (ccccccc) has passed Verify and Verify Windows; head aaaaaaa not verified yet",
    });
    expect(planNightly(behind).error).toBeUndefined();
    expect(planNightly({ ...behind, event: "workflow_dispatch" }).error).toContain("not verified yet");
    expect(planNightly({ ...behind, force: true })).toMatchObject({ build: true, publish: true, sha: sha("c") });
  });

  test("skips when main has not moved, unless forced", () => {
    expect(planNightly({ ...base, previousSha: base.head })).toMatchObject({ build: false, reason: "main has not moved since the last nightly build (aaaaaaa)" });
    expect(planNightly({ ...base, previousSha: base.head, force: true })).toMatchObject({ build: true, sha: base.head });
  });

  test("never publishes a commit one of the checks has not passed", () => {
    expect(planNightly({ ...base, verifyWindowsPassed: [], previousSha: null })).toMatchObject({ build: false, publish: false });
    expect(planNightly({ ...base, verifyPassed: [], previousSha: null, event: "workflow_dispatch" }).error).toBeDefined();
  });

  test("builds the commit the run started on when not publishing, verified or not", () => {
    expect(planNightly({ ...base, publish: false, verifyPassed: [], verifyWindowsPassed: [] })).toMatchObject({ build: true, publish: false, sha: sha("a") });
  });

  test("publishes only from main", () => {
    expect(planNightly({ ...base, onMain: false }).error).toBeDefined();
    expect(planNightly({ ...base, onMain: false, publish: false })).toMatchObject({ build: true, publish: false });
  });
});

describe("newestVerifiedCommit", () => {
  const sha = (letter: string) => letter.repeat(40);
  const history = ["a", "b", "c", "d", "e"].map(sha);

  test("never goes back past the last nightly build, whatever the checks say about it now", () => {
    // A re-run of its Verify failed, so it no longer reads as passed; the older d does.
    expect(newestVerifiedCommit(history, [sha("d")], [sha("d")], sha("c"))).toEqual({ sha: sha("c"), behind: 2 });
    // A newer verified commit still wins.
    expect(newestVerifiedCommit(history, [sha("b")], [sha("b")], sha("c"))).toEqual({ sha: sha("b"), behind: 1 });
    expect(newestVerifiedCommit(history, [sha("d")], [sha("d")], null)).toEqual({ sha: sha("d"), behind: 3 });
  });
});

describe("firstParentHistory", () => {
  test("follows first parents past a merge, leaving out its side branch, up to the limit", () => {
    const commits = [
      { sha: "m", parents: ["p1", "s2"] },
      { sha: "s2", parents: ["s1"] },
      { sha: "s1", parents: ["p1"] },
      { sha: "p1", parents: ["p0"] },
      { sha: "p0", parents: [] },
    ];
    expect(firstParentHistory("m", commits, 30)).toEqual(["m", "p1", "p0"]);
    expect(firstParentHistory("m", commits, 2)).toEqual(["m", "p1"]);
    // A head the listing does not know is still a window of one.
    expect(firstParentHistory("x", commits, 30)).toEqual(["x"]);
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
