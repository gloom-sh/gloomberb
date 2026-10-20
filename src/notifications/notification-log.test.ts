import { afterEach, describe, expect, test } from "bun:test";
import { JsonPersistence } from "../data/json-persistence";
import { BROWSER_STORAGE_KEYS, type StorageLike } from "../data/json-storage";
import type { AppNotificationRequest } from "../types/plugin";
import { createAppNotifier } from "./app-notifier";
import {
  NOTIFICATION_LOG_LIMIT,
  appendNotificationLog,
  attachNotificationLog,
  getNotificationLog,
  markNotificationLogRead,
  resetNotificationLogForTest,
  unreadNotificationLogCount,
} from "./notification-log";

afterEach(resetNotificationLogForTest);

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
}

function notifier(shown: AppNotificationRequest[] = []) {
  return createAppNotifier({ isAppActive: () => true, renderToast: (notification) => shown.push(notification), desktop: null });
}

describe("missed notice log", () => {
  test("keeps one row per ref, the newest 300", () => {
    for (let index = 0; index <= NOTIFICATION_LOG_LIMIT; index += 1) {
      appendNotificationLog({ body: `NVDA above ${index} triggered`, refId: `price:a${index}` }, 1_000 + index);
    }
    expect(getNotificationLog()).toHaveLength(NOTIFICATION_LOG_LIMIT);
    expect(getNotificationLog()[0]?.refId).toBe("price:a1");

    // Several catalyst rules matching one event make one row.
    appendNotificationLog({ body: "FDA decision on XYZ · Scheduled", refId: "catalyst:ev-9" }, 5_000);
    appendNotificationLog({ body: "FDA decision on XYZ · Scheduled", refId: "catalyst:ev-9" }, 5_001);
    expect(getNotificationLog().filter((entry) => entry.refId === "catalyst:ev-9")).toHaveLength(1);

    // A price rule that fires again replaces its row, unread and newest again.
    const first = getNotificationLog().find((entry) => entry.refId === "price:a7")!;
    markNotificationLogRead([first.id]);
    appendNotificationLog({ body: "NVDA above 7 triggered at 7.40", refId: "price:a7" }, 9_000);
    const log = getNotificationLog();
    expect(log).toHaveLength(NOTIFICATION_LOG_LIMIT);
    expect(log.at(-1)).toMatchObject({ id: first.id, body: "NVDA above 7 triggered at 7.40", at: 9_000, read: false });
  });

  test("the status bar counts missed alert, catalyst, economic release and team notices, never plain toasts", () => {
    const shown: AppNotificationRequest[] = [];
    const { notify } = notifier(shown);
    notify({ body: "Could not save alerts.json", type: "error" });
    notify({ body: "Alert set", type: "success" });
    notify({ body: "Layout copied", type: "info" });
    notify({ title: "#everyone", body: "@bob mentioned you: hey", type: "info", refId: "msg-1" });
    expect(getNotificationLog()).toEqual([]);
    expect(unreadNotificationLogCount()).toBe(0);

    let opened = 0;
    notify({ body: "AAPL above 230.00 triggered at 230.12", type: "success", refId: "price:alert-1", action: { label: "Open", onClick: () => { opened += 1; } } });
    notify({ body: "FDA decision on XYZ · Decided", type: "info", refId: "catalyst:ev-1" });
    notify({ title: "MD Macro Desk", body: "@carol invited you to Macro Desk. Run TEAM to accept.", type: "info", refId: "team:card-1" });
    notify({ title: "US", body: "CPI m/m 0.3% vs 0.3%", type: "info", refId: "econ:cpi" });
    expect(unreadNotificationLogCount()).toBe(4);

    // Pressing the toast's own button means it was not missed.
    shown.find((notification) => notification.refId === "price:alert-1")?.action?.onClick();
    expect(opened).toBe(1);
    expect(unreadNotificationLogCount()).toBe(3);
  });

  test("lives in this device's state store, outside config and synced settings", () => {
    const storage = new MemoryStorage();
    appendNotificationLog({ body: "TSLA below 200.00 triggered at 199.80", refId: "price:early" }, 1_000);
    attachNotificationLog(new JsonPersistence(storage).pluginState);
    notifier().notify({ title: "MD Macro Desk", body: "@carol published Morning r3.", refId: "team:card-2" });

    expect([...storage.items.keys()]).toEqual([BROWSER_STORAGE_KEYS.pluginState]);
    expect(storage.items.get(BROWSER_STORAGE_KEYS.pluginState)).toContain("@carol published Morning r3.");

    // A restart reads it back, notices recorded before the store was attached included.
    resetNotificationLogForTest();
    attachNotificationLog(new JsonPersistence(storage).pluginState);
    expect(getNotificationLog().map((entry) => entry.refId)).toEqual(["price:early", "team:card-2"]);
  });
});
