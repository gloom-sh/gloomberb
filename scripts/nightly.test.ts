import { describe, expect, test } from "bun:test";
import { compareSemver } from "../src/utils/semver";
import { isNightlyTag, nightlyBaseVersion, nightlyVersion, planNightly, prunableNightlies, type NightlyPlanInput } from "./nightly";

describe("nightly versions", () => {
  test("count up from the patch after the latest stable release, so they sort above it", () => {
    // main's package.json is the release it was tagged as.
    expect(nightlyBaseVersion("0.17.4", "v0.17.4")).toBe("0.17.5");
    // Bumped on main but not released yet: count up from there.
    expect(nightlyBaseVersion("0.18.0", "v0.17.4")).toBe("0.18.0");
    expect(() => nightlyBaseVersion("0.17.5-nightly.1", "v0.17.4")).toThrow();
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
  test("lists only nightly prereleases past the cutoff, never a stable release or the newest build", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const old = "2026-10-01T00:00:00Z";
    const releases = [
      { tag_name: "v0.17.5-nightly.20261001.3.gabcdef0", prerelease: true, draft: false, created_at: old },
      { tag_name: "v0.17.6-nightly.20261031.9.g1234567", prerelease: true, draft: false, created_at: "2026-10-31T00:00:00Z" },
      { tag_name: "v0.17.4", prerelease: false, draft: false, created_at: old },
      // Flagged prerelease but not a nightly tag, or a nightly tag GitHub does not flag: left alone.
      { tag_name: "v0.5.0", prerelease: true, draft: false, created_at: old },
      { tag_name: "v0.17.5-nightly.20261002.4.gabcdef1", prerelease: false, draft: false, created_at: old },
      { tag_name: "v0.17.5-nightly.20261003.5.gabcdef2", prerelease: true, draft: false, created_at: old },
    ];

    expect(prunableNightlies(releases, now, 14, "v0.17.5-nightly.20261003.5.gabcdef2")).toEqual([
      "v0.17.5-nightly.20261001.3.gabcdef0",
    ]);
  });
});
