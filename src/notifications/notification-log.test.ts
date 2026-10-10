import { afterEach, describe, expect, test } from "bun:test";
import {
  NOTIFICATION_LOG_LIMIT,
  appendNotificationLog,
  clearNotificationLog,
  configureNotificationLog,
  flushNotificationLog,
  getNotificationLog,
  markNotificationLogRead,
  resetNotificationLogForTest,
} from "./notification-log";

afterEach(resetNotificationLogForTest);

describe("notification log", () => {
  test("appends, trims, and persists notification history", async () => {
    const saved: unknown[][] = [];
    configureNotificationLog({
      get: () => [],
      set: (entries) => { saved.push([...entries]); },
    });

    for (let index = 0; index <= NOTIFICATION_LOG_LIMIT; index += 1) {
      appendNotificationLog({ body: `Notification ${index}`, type: "success" }, "alerts", index);
    }
    await flushNotificationLog();

    expect(getNotificationLog()).toHaveLength(NOTIFICATION_LOG_LIMIT);
    expect(getNotificationLog()[0]?.body).toBe("Notification 1");
    expect(getNotificationLog().at(-1)).toMatchObject({
      body: `Notification ${NOTIFICATION_LOG_LIMIT}`,
      source: "alerts",
      type: "success",
      read: false,
    });
    expect(saved.at(-1)).toHaveLength(NOTIFICATION_LOG_LIMIT);
  });

  test("marks selected entries read and clears the persisted list", async () => {
    const saved: unknown[][] = [];
    configureNotificationLog({ get: () => [], set: (entries) => { saved.push([...entries]); } });
    const first = appendNotificationLog({ body: "First" }, "app", 1);
    const second = appendNotificationLog({ body: "Second" }, "chat", 2);

    markNotificationLogRead([first.id]);
    expect(getNotificationLog()).toMatchObject([{ read: true }, { read: false }]);
    clearNotificationLog();
    await flushNotificationLog();

    expect(second.source).toBe("chat");
    expect(getNotificationLog()).toEqual([]);
    expect(saved.at(-1)).toEqual([]);
  });

  test("skips an identical body from the same source within ten minutes", () => {
    configureNotificationLog({ get: () => [], set: () => {} });
    const first = appendNotificationLog({ body: "Top News: Volkswagen" }, "news", 1_000);
    const second = appendNotificationLog({ body: "Top News: Volkswagen" }, "news", 1_000 + 60_000);
    expect(getNotificationLog()).toHaveLength(1);
    expect(second.id).toBe(first.id);
    appendNotificationLog({ body: "Top News: Volkswagen" }, "news", 1_000 + 11 * 60_000);
    expect(getNotificationLog()).toHaveLength(2);
  });

  test("upserts entries by refId instead of duplicating", () => {
    configureNotificationLog({ get: () => [], set: () => {} });
    const first = appendNotificationLog({ body: "first body", refId: "m1" }, "chat", 100);
    const second = appendNotificationLog({ body: "second body", refId: "m1" }, "chat", 200);

    expect(getNotificationLog()).toHaveLength(1);
    expect(second).toBe(first);
    expect(getNotificationLog()[0]).toMatchObject({
      body: "second body",
      source: "chat",
      at: 100,
      read: false,
      refId: "m1",
    });

    markNotificationLogRead();
    appendNotificationLog({ body: "later body", refId: "m1" }, "chat", 300);
    expect(getNotificationLog()[0]).toMatchObject({
      body: "later body",
      read: true,
      at: 100,
    });
  });

  test("an app success is already read, and a later alert fire is not", () => {
    configureNotificationLog({ get: () => [], set: () => {} });
    appendNotificationLog({ body: "Alert set", type: "success" }, "app", 1);
    appendNotificationLog({ body: "Could not save", type: "error" }, "app", 2);
    const fire = appendNotificationLog({ body: "AAPL > 200 triggered at 201.00", type: "success", refId: "price:a1" }, "alerts", 3);
    expect(getNotificationLog().map((entry) => entry.read)).toEqual([true, false, false]);

    markNotificationLogRead([fire.id]);
    appendNotificationLog({ body: "AAPL > 200 triggered at 205.00", type: "success", refId: "price:a1" }, "alerts", 4);
    expect(getNotificationLog().find((entry) => entry.refId === "price:a1")).toMatchObject({
      body: "AAPL > 200 triggered at 205.00",
      read: false,
    });
  });
});

test("queued writes retain the store that owned the notification", async () => {
  const savedA: unknown[] = [];
  const savedB: unknown[] = [];
  configureNotificationLog({ get: () => [], set: (entries) => { savedA.push(entries); } });
  appendNotificationLog({ body: "Account A" });
  configureNotificationLog({ get: () => [], set: (entries) => { savedB.push(entries); } });
  appendNotificationLog({ body: "Account B" });
  await flushNotificationLog();
  expect(savedA).toMatchObject([[{ body: "Account A" }]]);
  expect(savedB).toMatchObject([[{ body: "Account B" }]]);
});
