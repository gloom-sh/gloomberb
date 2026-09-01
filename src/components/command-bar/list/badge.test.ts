import { describe, expect, test } from "bun:test";
import { badgeConsumesRight, resolveBadgeColumnWidth, resolveRowBadge } from "./badge";

describe("command bar row badges", () => {
  test("lifts a shortcut out of the right column and leaves descriptions there", () => {
    expect(resolveRowBadge({ kind: "command", right: "EVT" })).toEqual({ text: "EVT", tone: "command" });
    expect(resolveRowBadge({ kind: "action", right: "10-K" })).toEqual({ text: "10-K", tone: "command" });
    expect(badgeConsumesRight({ kind: "command", right: "EVT" })).toBe(true);

    for (const right of ["Equity NASDAQ", "current", "on", "WIN move", "TOOLONG", "e"]) {
      expect(resolveRowBadge({ kind: "command", right })).toBeNull();
    }
    expect(resolveRowBadge({ kind: "command" })).toBeNull();
  });

  test("keeps an explicit badge and the right column both", () => {
    const row = { kind: "action" as const, badge: "NEWS", right: "NVDA" };
    expect(resolveRowBadge(row)).toEqual({ text: "NEWS", tone: "document" });
    expect(badgeConsumesRight(row)).toBe(false);
  });

  test("tones follow the row kind and placeholders get nothing", () => {
    expect(resolveRowBadge({ kind: "ticker", right: "EQ" })?.tone).toBe("instrument");
    expect(resolveRowBadge({ kind: "search", badge: "EQ" })?.tone).toBe("instrument");
    expect(resolveRowBadge({ kind: "info", right: "EQ" })).toBeNull();
    expect(resolveRowBadge({ kind: "plugin", right: "EQ" })).toBeNull();
  });

  test("pads the column to the widest badge within four to six cells", () => {
    expect(resolveBadgeColumnWidth([{ kind: "command", right: "Long description" }])).toBe(0);
    expect(resolveBadgeColumnWidth([{ kind: "command", right: "T" }])).toBe(4);
    expect(resolveBadgeColumnWidth([{ kind: "command", right: "T" }, { kind: "action", badge: "FILING" }])).toBe(6);
  });
});
