import { expect, test } from "bun:test";
import {
  createEventAlert, EVENT_ALERTS_KEY, IV_LEVEL_ALERTS_KEY, readEventAlerts, readEventAlertStores, toggleEventAlert, updateEventAlerts, writeEventAlertStores,
} from "./events";
import { createResearchAlert } from "./research-builder";

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

test("rejects out-of-range synced timestamps before rendering a date", () => {
  const rule = createEventAlert("congress-watched", "", 1000);
  expect(readEventAlerts(JSON.stringify([{...rule, createdAt: 1e300}]))).toEqual({rules:[],error:"Saved event alerts could not be read.",kept:[]});
});

// A released version refused the whole list over one rule of a kind it did not know, so every event alert stopped.
test("a rule of a kind this version does not know is skipped, and saved back unchanged with the rest", () => {
  const member = createEventAlert("congress-member", "Nancy Pelosi", 1000);
  const future = { id: "future-1", kind: "gamma_wall", target: "rule", value: "{}", status: "active", createdAt: 1000, check: { any: true } };
  const read = readEventAlerts(JSON.stringify([member, future]));
  expect(read).toEqual({ rules: [member], error: null, kept: [future] });
  // A duplicate id is still a list that does not read, whatever its kind.
  expect(readEventAlerts(JSON.stringify([member, { ...future, id: member.id }])).error).not.toBeNull();

  const paused = JSON.parse(updateEventAlerts(JSON.stringify([member, future]), (rules) => rules.map((rule) => toggleEventAlert(rule, 2000))));
  expect(paused).toEqual([{ ...member, status: "paused" }, future]);
  expect(updateEventAlerts("broken", () => [])).toBe("broken");
});

test("IV level rules are kept in their own list, which released versions never read", () => {
  const member = createEventAlert("congress-member", "Nancy Pelosi", 1000);
  const level = createResearchAlert("iv_level", { "iv_level:symbol": "IBIT", "iv_level:exchange": "US", "iv_level:metric": "atm", "iv_level:direction": "above", "iv_level:threshold": "50" }, 1000);
  const config: Record<string, string> = { [EVENT_ALERTS_KEY]: JSON.stringify([member]) };
  const stores = readEventAlertStores((key) => config[key]);
  const written = writeEventAlertStores(stores.lists, [...stores.rules, level]);
  // Only the list that changed is written.
  expect(Object.keys(written)).toEqual([IV_LEVEL_ALERTS_KEY]);
  expect(JSON.parse(written[IV_LEVEL_ALERTS_KEY]!)).toEqual([level]);
  const after = readEventAlertStores((key) => ({ ...config, ...written })[key]);
  expect(after.rules.map((rule) => rule.kind)).toEqual(["congress_trade", "iv_level"]);
});
