import { describe, expect, test } from "bun:test";
import { normalizeSessionUser } from "./persistence";
import { sessionUserFromApiSession } from "./session";

describe("chat session market entitlement", () => {
  test("preserves plan through cached and refreshed desktop session mappings", () => {
    expect(
      normalizeSessionUser({
        id: "user-1",
        emailVerified: true,
        username: "vince",
        plan: "pro",
      }),
    ).toMatchObject({ id: "user-1", plan: "pro" });

    expect(
      sessionUserFromApiSession({
        id: "user-1",
        emailVerified: true,
        username: "vince",
        plan: "free",
      }),
    ).toMatchObject({ id: "user-1", plan: "free" });
  });
});
