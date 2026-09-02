import { describe, expect, test } from "bun:test";
import { BADGE_COLUMN_WIDTH, badgeConsumesRight, resolveRowBadge } from "./badge";

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
    const row = { kind: "action" as const, badge: "NEWS", right: "Aug 30" };
    expect(resolveRowBadge(row)).toEqual({ text: "NEWS", tone: "document" });
    expect(badgeConsumesRight(row)).toBe(false);
    // The "search all" row keeps its shortcut on the right under its own tag.
    expect(resolveRowBadge({ kind: "action", badge: "DOCS", right: "SRCH" })).toEqual({ text: "DOCS", tone: "document" });
  });

  /**
   * An unclassified instrument has no class tag, so its exchange code is
   * lifted from the right column instead; a long venue name stays there and
   * the row goes badge-less.
   */
  test("tags instruments by class, or by a short exchange code when the class is unknown", () => {
    expect(resolveRowBadge({ kind: "search", badge: "EQ", right: "NASDAQ" })).toEqual({ text: "EQ", tone: "instrument" });
    expect(resolveRowBadge({ kind: "ticker", right: "CCC" })).toEqual({ text: "CCC", tone: "instrument" });
    expect(badgeConsumesRight({ kind: "ticker", right: "CCC" })).toBe(true);
    expect(resolveRowBadge({ kind: "search", right: "Cboe Global" })).toBeNull();
  });

  test("tags AI answers with their prefix in the assist tone, upper-cased", () => {
    expect(resolveRowBadge({ kind: "action", badge: "des", accent: true })).toEqual({ text: "DES", tone: "assist" });
    expect(resolveRowBadge({ kind: "info", accent: true, right: "✦" })).toBeNull();
    expect(resolveRowBadge({ kind: "plugin", right: "EQ" })).toBeNull();
  });

  /**
   * Sections land at different times and their badges are not the same width,
   * so a column measured from the rows on screen would widen when instruments
   * or documents arrive and shift every label above them sideways.
   */
  test("holds a column wide enough for any badge the bar can show", () => {
    for (const badge of ["EQ", "ETF", "DERIV", "SYM", "NEWS", "CALL", "DOCS", "SRCH", "10-K", "8-K", "ABCDEF"]) {
      expect(resolveRowBadge({ kind: "action", badge })?.text.length).toBeLessThanOrEqual(BADGE_COLUMN_WIDTH);
    }
    // Six characters is what the shortcut pattern admits; a seventh is prose.
    expect(resolveRowBadge({ kind: "command", right: "ABCDEFG" })).toBeNull();
  });
});
