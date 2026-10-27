import { expect, test } from "bun:test";
import { alertChangeEntry, appendAlertLog, appendFiredAlert, MAX_ALERT_CHANGES, MAX_FIRED_ALERTS, readFiredAlerts, recordFiredAlertFor, type FiredAlert } from "./fired-log";
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

test("creating, re-arming and deleting rules never push an alert that went off out of the log, and each kind drops only its own oldest", () => {
  let entries: FiredAlert[] = [];
  for (let minute = 0; minute < MAX_FIRED_ALERTS; minute++) entries = appendFiredAlert(entries, input("price", `fired ${minute}`, minute));
  const change = (n: number) => alertChangeEntry(n % 3 === 0 ? "created" : n % 3 === 1 ? "rearmed" : "deleted",
    { kind: "price", ruleId: `rule ${n}`, rule: `change ${n}` }, AT + (MAX_FIRED_ALERTS + n) * 60_000);
  // Through the pane's state, then the shell's.
  for (let n = 0; n < MAX_ALERT_CHANGES; n++) entries = appendFiredAlert(entries, change(n));
  const state = new Map<string, unknown>([["firedLog", entries]]);
  appendAlertLog({ get: (key) => state.get(key), set: (key, value) => state.set(key, value) },
    Array.from({ length: 50 }, (_, n) => change(MAX_ALERT_CHANGES + n)));
  let kept = readFiredAlerts(state.get("firedLog"));
  const fired = (log: FiredAlert[]) => log.filter((entry) => !entry.action);
  const changes = (log: FiredAlert[]) => log.filter((entry) => entry.action);
  expect(fired(kept)).toHaveLength(MAX_FIRED_ALERTS);
  expect(fired(kept)[0]).toMatchObject({ rule: "fired 0" });
  expect(changes(kept)).toHaveLength(MAX_ALERT_CHANGES);
  expect(changes(kept)[0]).toMatchObject({ rule: "change 50" });
  // An alert going off on a full log drops the oldest alert, never a change; a live scan's cap counts only alerts.
  kept = appendFiredAlert(kept, input("price", "fired new", 5000));
  const runtime = {
    getResumeState: () => kept,
    setResumeState: (_plugin: string, _key: string, value: unknown) => { kept = readFiredAlerts(value); },
  };
  recordFiredAlertFor(runtime, [input("live_scan", "scan new", 5001)], () => {}, 10);
  expect(fired(kept).map((entry) => entry.rule).slice(0, 1)).toEqual(["fired 2"]);
  expect(changes(kept)).toHaveLength(MAX_ALERT_CHANGES);
  expect(changes(kept)[0]).toMatchObject({ rule: "change 50" });
});
