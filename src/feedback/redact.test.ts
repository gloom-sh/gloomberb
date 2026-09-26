import { describe, expect, test } from "bun:test";
import { redactText, redactValue } from "./redact";

describe("redactText", () => {
  test("removes credentials by name and by shape", () => {
    const input = [
      "GET wss://api.gloom.sh/cloud/ws?token=abc123def&symbols=AAPL",
      "Authorization: Bearer s3cr3t.token-value",
      "cookie: better-auth.session_token=zzz; other=1",
      '{"password":"hunter2","symbol":"MSFT"}',
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "key phc_AbCdEf1234567890xyz and sk_test_51H8abcdefghijk",
      "opaque b3BhcXVlIGZlZWRiYWNrIHRlc3QgcGF5bG9hZCAxMjM0NTY=",
    ].join("\n");
    const output = redactText(input);
    for (const secret of ["abc123def", "s3cr3t", "zzz", "hunter2", "eyJhbGciOiJIUzI1NiJ9", "phc_AbCdEf", "sk_test_51H8", "b3BhcXVl"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("symbols=AAPL");
    expect(output).toContain('"symbol":"MSFT"');
  });

  test("hides people and accounts but keeps market data and timestamps", () => {
    const output = redactText(
      "ada@example.com synced account U1234567 acct no 12345678 at 1727100000000 (1727100000) from /Users/ada/.gloomberb and C:\\Users\\ada\\x; 123456789012 AAPL 231.45",
    );
    expect(output).not.toContain("ada@example.com");
    expect(output).not.toContain("12345678 ");
    expect(output).not.toContain("123456789012");
    expect(output).not.toContain("/Users/ada");
    expect(output).not.toContain("Users\\ada");
    expect(output).toContain("1727100000000");
    expect(output).toContain("1727100000");
    expect(output).toContain("AAPL 231.45");
  });
});

describe("redactValue", () => {
  test("drops secret-named keys at any depth and scrubs strings", () => {
    expect(redactValue({
      plan: "pro",
      auth: { hasSessionToken: true, sessionToken: "x" },
      broker: { apiKey: "k", note: "Bearer abcdef" },
    })).toEqual({
      plan: "pro",
      auth: {},
      broker: { note: "Bearer [redacted]" },
    });
  });
});
