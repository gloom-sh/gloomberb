import { expect, test } from "bun:test";
import { tapeRejection } from "./client";

test("a rejected tape request shows its stated reason", () => {
  expect(tapeRejection('{"symbol":"AMD:XNAS","status":"unavailable","gaps":["A US equity symbol is required"]}')).toBe("A US equity symbol is required");
  expect(tapeRejection("Bad Gateway")).toBeNull();
  expect(tapeRejection('{"gaps":[]}')).toBeNull();
});
