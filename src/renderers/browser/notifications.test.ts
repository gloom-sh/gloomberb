import { expect, mock, test } from "bun:test";
import { createBrowserNotifications } from "./notifications";

function notificationHarness(initialPermission: NotificationPermission, reply: NotificationPermission = "granted") {
  const items = new Map<string, string>();
  const banners: FakeNotification[] = [];
  class FakeNotification {
    static permission = initialPermission;
    static requestPermission = mock(async () => FakeNotification.permission = reply);
    onclick: ((event: Event) => void) | null = null;
    close = mock(() => {});

    constructor(readonly title: string, readonly options: NotificationOptions) {
      banners.push(this);
    }
  }
  const focus = mock(() => {});
  const isActive = mock(() => false);
  const create = () => createBrowserNotifications({
    getApi: () => FakeNotification,
    getStorage: () => ({
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => { items.set(key, value); },
      removeItem: (key) => { items.delete(key); },
    }),
    isActive,
    focus,
  });
  return { api: FakeNotification, banners, create, focus, isActive };
}

test("asks only on opt-in, persists it, and opens a banner's action only on click", async () => {
  const { api, banners, create, focus, isActive } = notificationHarness("default");
  const notifications = create();
  const open = mock(() => {});
  const request = { title: "@bob", body: "Hello", action: { label: "Open", onClick: open } };

  expect(notifications.notify(request)).toBe(false);
  expect(api.requestPermission).not.toHaveBeenCalled();
  expect(await notifications.setEnabled(true)).toBe("changed");
  expect(api.requestPermission).toHaveBeenCalledTimes(1);

  const reopened = create();
  isActive.mockReturnValueOnce(true);
  expect(reopened.notify(request)).toBe(false);
  expect(reopened.notify(request)).toBe(true);
  expect(banners).toHaveLength(1);
  expect(banners[0]).toMatchObject({ title: "@bob", options: { body: "Hello", silent: true } });
  expect(open).not.toHaveBeenCalled();
  banners[0]!.onclick?.(new Event("click"));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);

  expect(await reopened.setEnabled(false)).toBe("changed");
  expect(notifications.notify(request)).toBe(false);
});

test("browser permission alone does not opt in, and denying the prompt leaves banners off", async () => {
  const granted = notificationHarness("granted").create();
  expect(granted.notify({ body: "Hello" })).toBe(false);

  const { api, create } = notificationHarness("default", "denied");
  const notifications = create();
  expect(await notifications.setEnabled(true)).toBe("denied");
  expect(await notifications.setEnabled(true)).toBe("denied");
  expect(api.requestPermission).toHaveBeenCalledTimes(1);
  api.permission = "granted";
  expect(notifications.notify({ body: "Hello" })).toBe(false);
});
