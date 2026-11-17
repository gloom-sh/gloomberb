import { describe, expect, test } from "bun:test";
import { applyProfileEdits, diffProfile, type ProfileJson } from "./profile-merge";

/** What `mine` becomes once the other program's change from `base` to `theirs` is folded in. */
function fold(base: ProfileJson, theirs: ProfileJson, mine: ProfileJson, conflicts?: "keep" | "take"): ProfileJson {
  return applyProfileEdits(mine, diffProfile(base, theirs), { conflicts });
}

const alerts = (...rows: object[]) => JSON.stringify(rows);

describe("profile merge", () => {
  test("an alert added to a stored list survives the app rewriting another alert's reading in it", () => {
    const base = { theme: "amber", pluginConfig: { alerts: { alerts: alerts({ id: "a", lastCheckedPrice: 1 }) } } };
    const cli = { ...base, pluginConfig: { alerts: { alerts: alerts({ id: "a", lastCheckedPrice: 1 }, { id: "b", symbol: "Z74" }) } } };
    const app = { theme: "nord", pluginConfig: { alerts: { alerts: alerts({ id: "a", lastCheckedPrice: 2 }) } } };

    const merged = fold(base, cli, app) as typeof app;

    expect(merged.theme).toBe("nord");
    expect(JSON.parse(merged.pluginConfig.alerts.alerts)).toEqual([{ id: "a", lastCheckedPrice: 2 }, { id: "b", symbol: "Z74" }]);
  });

  test("a removal lands over an edit, and an edit inside a removed record is dropped", () => {
    const base = { watchlists: [{ id: "w", name: "Watch" }, { id: "x", name: "Extra" }] };
    const cli = { watchlists: [{ id: "w", name: "Watch" }] };
    const app = { watchlists: [{ id: "w", name: "Watch" }, { id: "x", name: "Renamed" }] };
    expect(fold(base, cli, app)).toEqual({ watchlists: [{ id: "w", name: "Watch" }] });

    const renamedElsewhere = { watchlists: [{ id: "w", name: "Watch" }, { id: "x", name: "Other" }] };
    expect(fold(base, renamedElsewhere, cli)).toEqual(cli);
  });

  test("a value both sides changed keeps the target's, unless it takes the edits'", () => {
    const base = { theme: "amber", fontSize: 12 };
    const theirs = { theme: "nord", fontSize: 14 };
    const mine = { theme: "white", fontSize: 12 };
    expect(fold(base, theirs, mine)).toEqual({ theme: "white", fontSize: 14 });
    expect(fold(base, theirs, mine, "take")).toEqual({ theme: "nord", fontSize: 14 });
  });

  test("lists of ids merge as sets, and records keep both sides' additions in place", () => {
    const base = { watchlists: ["watchlist"], portfolios: [{ id: "main" }, { id: "p2" }] };
    const theirs = { watchlists: ["watchlist", "cli"], portfolios: [{ id: "main" }, { id: "cli" }, { id: "p2" }] };
    const mine = { watchlists: ["watchlist", "app"], portfolios: [{ id: "main" }, { id: "p2" }, { id: "app" }] };
    expect(fold(base, theirs, mine)).toEqual({
      watchlists: ["watchlist", "app", "cli"],
      portfolios: [{ id: "main" }, { id: "cli" }, { id: "p2" }, { id: "app" }],
    });
  });
});
