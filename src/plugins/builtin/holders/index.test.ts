import { expect, test } from "bun:test";
import {
  formatHolderOwnershipPercent,
  resolveHolderOwnershipPercent,
} from "./format";

test("resolves holder ownership from provider percent, then share counts, then value over market cap", () => {
  expect(resolveHolderOwnershipPercent({ percentHeld: 0.085, value: 120 }, 1_000)).toBe(0.085);
  // Share counts do not move with the price the way value over today's cap does.
  expect(resolveHolderOwnershipPercent({ value: 120, shares: 30 }, 1_000, 600)).toBe(0.05);
  expect(resolveHolderOwnershipPercent({ value: 120 }, 1_000)).toBe(0.12);
  expect(resolveHolderOwnershipPercent({ value: 120 }, undefined)).toBeUndefined();
  expect(formatHolderOwnershipPercent(0.085)).toBe("8.50%");
});
