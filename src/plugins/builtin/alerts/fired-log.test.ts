import { expect, test } from "bun:test";
import { appendFiredAlert, MAX_FIRED_ALERTS, readFiredAlerts, recordFiredAlertFor, type FiredAlert } from "./fired-log";
import { ALERTS_PLUGIN_ID } from "./constants";

const AT = Date.UTC(2026, 9, 26, 18, 0, 0);
const input = (kind: string, rule: string, minutes: number) => ({
  kind, ruleId: rule, rule, firedAt: AT + minutes * 60_000, value: 1, quoteAt: null, source: null,
});

test("a busy live scan keeps only its own newest entries, and never pushes a price alert out of the shared history", () => {
  let entries: FiredAlert[] = [];
  entries = appendFiredAlert(entries, input("price", "AAPL above 200", 0));
  for (let minute = 1; minute < MAX_FIRED_ALERTS; minute++) entries = appendFiredAlert(entries, input("live_scan", `scan ${minute}`, minute));
  const state = new Map<string, unknown>([[`${ALERTS_PLUGIN_ID}:firedLog`, entries]]);
  const runtime = {
    getResumeState: (plugin: string, key: string) => state.get(`${plugin}:${key}`),
    setResumeState: (plugin: string, key: string, value: unknown) => { state.set(`${plugin}:${key}`, value); },
  };
  recordFiredAlertFor(runtime, [input("live_scan", "scan new", MAX_FIRED_ALERTS)], () => {}, 100);
  const kept = readFiredAlerts(state.get(`${ALERTS_PLUGIN_ID}:firedLog`));
  expect(kept.filter((entry) => entry.kind === "live_scan")).toHaveLength(100);
  expect(kept[0]).toMatchObject({ kind: "price", rule: "AAPL above 200" });
  expect(kept.at(-1)).toMatchObject({ rule: "scan new" });
  expect(kept[1]).toMatchObject({ rule: `scan ${MAX_FIRED_ALERTS - 99}` });
});
