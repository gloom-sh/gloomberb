import { describe, expect, test } from "bun:test";
import {
  advanceAccountField,
  classifyAccountError,
  deriveUsernameFromEmail,
  isUsernameConflictError,
} from "./auth-model";

describe("deriveUsernameFromEmail", () => {
  test("builds a server-legal username from the email local part", () => {
    expect(deriveUsernameFromEmail("Vincent.Loewert@gmail.com")).toBe("vincent_loewert");
    expect(deriveUsernameFromEmail("9lives@example.com")).toBe("u9lives");
    expect(deriveUsernameFromEmail("a@example.com")).toBe("a00");
    expect(deriveUsernameFromEmail("--weird--name--@example.com")).toBe("weird_name");
  });

  test("stays within the 30 character limit, with and without a retry suffix", () => {
    const long = `${"abcdefghij".repeat(4)}@example.com`;
    expect(deriveUsernameFromEmail(long)).toHaveLength(30);

    const retried = deriveUsernameFromEmail(long, 1);
    expect(retried.length).toBeLessThanOrEqual(30);
    expect(retried).not.toBe(deriveUsernameFromEmail(long));
  });
});

describe("isUsernameConflictError", () => {
  test("only matches username collisions, so a duplicate email never re-posts a sign-up", () => {
    expect(isUsernameConflictError(new Error("Username is already taken"))).toBe(true);
    expect(isUsernameConflictError(new Error("User already exists USER_ALREADY_EXISTS"))).toBe(false);
    expect(isUsernameConflictError(new Error("fetch failed"))).toBe(false);
  });
});

describe("classifyAccountError", () => {
  test("routes a duplicate email to the login form instead of a pointless retry", () => {
    const result = classifyAccountError(new Error("User already exists USER_ALREADY_EXISTS"), "signup");
    expect(result.kind).toBe("switch-to-login");
  });

  test("keeps every other failure retryable and surfaces the server message", () => {
    expect(classifyAccountError(new Error("fetch failed"), "signup")).toEqual({
      message: "fetch failed",
      kind: "retry",
    });
    expect(classifyAccountError(new Error("Invalid email or password"), "login").kind).toBe("retry");
    expect(classifyAccountError({}, "login").message).toBe("Could not sign you in.");
  });
});

describe("advanceAccountField", () => {
  test("blocks the network call until both fields validate", () => {
    expect(advanceAccountField({ mode: "signup", email: "nope", password: "", fieldIdx: 0 }).action)
      .toBe("invalid");
    expect(advanceAccountField({ mode: "signup", email: "a@b.co", password: "", fieldIdx: 0 }))
      .toEqual({ action: "next-field", fieldIdx: 1 });
    expect(advanceAccountField({ mode: "signup", email: "a@b.co", password: "short", fieldIdx: 1 }).action)
      .toBe("invalid");
    expect(advanceAccountField({ mode: "signup", email: "a@b.co", password: "longenough", fieldIdx: 1 }).action)
      .toBe("submit");
  });

  test("does not impose the sign-up length rule on existing passwords", () => {
    expect(advanceAccountField({ mode: "login", email: "a@b.co", password: "short", fieldIdx: 1 }).action)
      .toBe("submit");
  });
});
