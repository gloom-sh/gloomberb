import { expect, test } from "bun:test";
import { createEventAlert, readEventAlerts, toggleEventAlert } from "./events";

test("event rule storage preserves targets and validates CIKs", () => {
  const fund = createEventAlert("thirteenf-fund", "1067983", 1000);
  const member = createEventAlert("congress-member", " Nancy Pelosi:CA11 ", 1000);
  const parsed = readEventAlerts(JSON.stringify([fund, member]));
  expect(parsed.error).toBeNull();
  expect(parsed.rules[0]?.value).toBe("0001067983");
  expect(parsed.rules[1]?.value).toBe("Nancy Pelosi:CA11");
  expect(() => createEventAlert("thirteenf-fund", "Berkshire")).toThrow();
  expect(readEventAlerts(JSON.stringify([fund, fund])).error).not.toBeNull();
  expect(readEventAlerts("broken").error).not.toBeNull();
});

test("resuming starts a new window without changing the dedupe identity", () => {
  const original = createEventAlert("congress-watched", "", 1000);
  const paused = toggleEventAlert(original, 2000);
  expect(paused.createdAt).toBe(1000);
  expect(paused.status).toBe("paused");
  const resumed = toggleEventAlert(paused, 3000);
  expect(resumed).toMatchObject({ id: original.id, status: "active", createdAt: 3000 });
});
