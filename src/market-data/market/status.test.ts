import { describe, expect, test } from "bun:test";
import { marketStateCountdown } from "./status";

describe("marketStateCountdown", () => {
  test("adds precision as the US session boundary approaches", () => {
    expect(marketStateCountdown("PRE", Date.parse("2026-08-18T12:21:42Z"))).toBe("1h 9m");
    expect(marketStateCountdown("PRE", Date.parse("2026-08-18T13:25:09Z"))).toBe("4m 51s");
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T18:59:59Z"))).toBeNull();
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T19:00:00Z"))).toBe("1h");
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T19:50:42Z"))).toBe("9m 18s");
  });
});
