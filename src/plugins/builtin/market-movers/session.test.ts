import { describe, expect, test } from "bun:test";
import { resolveActiveTab, usSessionAt, type UsSession } from "./session";

const newYork = (iso: string) => Date.parse(iso);
const TABS = ["gainers", "losers", "actives", "trending", "premarket", "afterhours", "gaps"] as const;
const session = (phase: UsSession["phase"], date = "2026-09-29"): UsSession => ({ date, phase, key: `${date}:${phase}` });

describe("the session that is trading", () => {
  test("follows New York hours on the published calendar", () => {
    // 2026-09-29 is a Tuesday in daylight time (UTC-4).
    expect(usSessionAt(newYork("2026-09-29T07:59:00Z")).phase).toBe("closed");
    expect(usSessionAt(newYork("2026-09-29T08:00:00Z")).phase).toBe("pre");
    expect(usSessionAt(newYork("2026-09-29T13:29:59Z")).phase).toBe("pre");
    expect(usSessionAt(newYork("2026-09-29T13:30:00Z")).phase).toBe("regular");
    expect(usSessionAt(newYork("2026-09-29T20:00:00Z")).phase).toBe("post");
    expect(usSessionAt(newYork("2026-09-30T00:00:00Z"))).toEqual({ date: "2026-09-29", phase: "closed", key: "2026-09-29:closed" });
  });

  test("keeps holidays closed and ends after hours four hours after an early close", () => {
    // Thanksgiving, then the 13:00 close the day after (standard time, UTC-5).
    expect(usSessionAt(newYork("2026-11-26T15:00:00Z")).phase).toBe("closed");
    expect(usSessionAt(newYork("2026-11-27T18:30:00Z")).phase).toBe("post");
    expect(usSessionAt(newYork("2026-11-27T22:00:00Z")).phase).toBe("closed");
  });
});

describe("the list MOST opens on", () => {
  const pick = (saved: string, pickedIn: string | null, now: UsSession, tabs: readonly string[] = TABS) =>
    resolveActiveTab({ tabs, saved, pickedIn, session: now });

  test("defaults to the session that is trading", () => {
    expect(pick("gainers", null, session("pre"))).toBe("premarket");
    expect(pick("losers", null, session("regular"))).toBe("losers");
    expect(pick("premarket", "2026-09-29:pre", session("regular"))).toBe("gainers");
    expect(pick("gainers", "2026-09-29:regular", session("post"))).toBe("afterhours");
  });

  test("keeps a pick while its session lasts, then lets it go", () => {
    expect(pick("gainers", "2026-09-29:pre", session("pre"))).toBe("gainers");
    expect(pick("gainers", "2026-09-28:pre", session("pre"))).toBe("premarket");
    // The day's lists carry through the regular session; gaps is one of them.
    expect(pick("gaps", "2026-09-29:pre", session("regular"))).toBe("gaps");
  });

  test("overnight and on closed days the last list stands", () => {
    expect(pick("afterhours", "2026-09-28:post", session("closed"))).toBe("afterhours");
    expect(pick("losers", null, session("closed"))).toBe("losers");
  });

  test("a session list asked for from the CLI is kept whatever is trading", () => {
    expect(pick("afterhours", null, session("regular"))).toBe("afterhours");
    expect(pick("premarket", null, session("post"))).toBe("premarket");
  });

  test("only offers lists the pane is set to show", () => {
    const regularOnly = ["gainers", "losers"];
    expect(pick("losers", null, session("pre"), regularOnly)).toBe("losers");
    expect(pick("afterhours", null, session("regular"), regularOnly)).toBe("gainers");
    expect(pick("premarket", "2026-09-29:pre", session("regular"), ["premarket", "afterhours"])).toBe("premarket");
  });
});
