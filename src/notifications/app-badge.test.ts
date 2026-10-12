import { describe, expect, test } from "bun:test";
import { appBadgeLabel } from "./app-badge";

describe("appBadgeLabel", () => {
  test("shows nothing at zero, the count up to 99 and 99+ above", () => {
    expect(appBadgeLabel(0)).toBe("");
    expect(appBadgeLabel(-3)).toBe("");
    expect(appBadgeLabel(Number.NaN)).toBe("");
    expect(appBadgeLabel(Number.POSITIVE_INFINITY)).toBe("");
    expect(appBadgeLabel(1)).toBe("1");
    expect(appBadgeLabel(42)).toBe("42");
    expect(appBadgeLabel(99)).toBe("99");
    expect(appBadgeLabel(100)).toBe("99+");
    expect(appBadgeLabel(2500)).toBe("99+");
  });
});
