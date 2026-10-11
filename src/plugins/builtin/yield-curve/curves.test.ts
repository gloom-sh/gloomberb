import { describe, expect, test } from "bun:test";
import { compareDate, isCompareSpan, parseCompareInput } from "./curves";

const now = new Date("2026-10-10T12:00:00Z");

describe("the compare input", () => {
  test("takes a span of days, weeks, months or years, in either case, before it takes a date", () => {
    for (const span of ["1D", "1d", "2W", "1M", "3m", "10Y"]) expect(parseCompareInput(span, now)).toBe(span.toUpperCase());
    expect(parseCompareInput("2026-10-02", now)).toBe("2026-10-02");
    expect(parseCompareInput("  ", now)).toBe("");
  });

  test("anything else gets the help for both forms, whether or not it looks like a date", () => {
    for (const input of ["latest", "nope", "1X", "0D", "1996", "2026-13-40", "10/02/2026"]) {
      expect(() => parseCompareInput(input, now)).toThrow("Compare with a date in YYYY-MM-DD format or a span such as 1D, 1W, 3M or 1Y.");
    }
    // A real date still cannot be in the future.
    expect(() => parseCompareInput("2026-10-11", now)).toThrow("future date");
    expect(isCompareSpan("0W")).toBe(false);
  });

  test("a span counts back from the session shown: days and weeks exactly, months and years to the same day or the month's last", () => {
    expect(compareDate("1D", "2026-10-09")).toBe("2026-10-08");
    expect(compareDate("3D", "2026-03-02")).toBe("2026-02-27");
    expect(compareDate("1W", "2026-10-09")).toBe("2026-10-02");
    expect(compareDate("1M", "2026-03-31")).toBe("2026-02-28");
    expect(compareDate("1Y", "2024-02-29")).toBe("2023-02-28");
    expect(compareDate("2026-01-05", "2026-10-09")).toBe("2026-01-05");
  });
});
