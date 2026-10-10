import { describe, expect, test } from "bun:test";
import {
  catalystEventIdFromRef,
  notificationCountsOnStatusBadge,
  priceAlertIdFromRef,
} from "./filter";

describe("notification status badge", () => {
  test("counts a price or catalyst fire and skips chat and team refs", () => {
    expect(notificationCountsOnStatusBadge({ read: false })).toBe(true);
    expect(notificationCountsOnStatusBadge({ read: true })).toBe(false);
    expect(notificationCountsOnStatusBadge({ read: false, refId: "price:a1" })).toBe(true);
    expect(notificationCountsOnStatusBadge({ read: false, refId: "catalyst:e1" })).toBe(true);
    expect(notificationCountsOnStatusBadge({ read: true, refId: "price:a1" })).toBe(false);
    expect(notificationCountsOnStatusBadge({ read: false, refId: "m1" })).toBe(false);
    expect(notificationCountsOnStatusBadge({ read: false, refId: "team:t1" })).toBe(false);
    expect(priceAlertIdFromRef("price:a1")).toBe("a1");
    expect(catalystEventIdFromRef("catalyst:e1")).toBe("e1");
    expect(priceAlertIdFromRef("m1")).toBeNull();
  });
});
