import { describe, expect, it } from "bun:test";
import { buildBriefProfile, rankedBriefBuiltins } from "./profile";

describe("brief profile", () => {
  it("ranks earnings first for earnings-heavy users", () => {
    const profile = buildBriefProfile({
      recentTickers: ["AAPL"],
      recentCommands: [{ id: "pane-template:earnings", label: "Earnings" } as any],
      layout: { dockRoot: null, instances: [{ instanceId: "1", paneId: "earnings" }], floating: [], detached: [] },
    } as any);
    expect(rankedBriefBuiltins(profile)[0]).toBe("earnings");
  });
  it("keeps canonical order on empty profile", () => {
    expect(rankedBriefBuiltins(buildBriefProfile(null as any))).toEqual(["headlines", "today", "earnings"]);
  });
});
