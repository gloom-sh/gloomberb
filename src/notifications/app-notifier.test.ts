import { describe, expect, test } from "bun:test";
import {
  buildDesktopNotificationCommand,
  buildSoundCommand,
  createAppNotifier,
  createDesktopNotifier,
} from "./app-notifier";

describe("desktop notification commands", () => {
  test("builds a macOS notification command", () => {
    const command = buildDesktopNotificationCommand({
      title: "Chat mention",
      body: "@bob mentioned you",
      subtitle: "#everyone",
    }, "darwin");

    expect(command).toEqual({
      command: "osascript",
      args: ["-e", "display notification \"@bob mentioned you\" with title \"Chat mention\" subtitle \"#everyone\""],
    });
  });

  test("builds a Linux notification command", () => {
    const command = buildDesktopNotificationCommand({
      title: "Chat mention",
      body: "@bob mentioned you",
      subtitle: "#everyone",
      type: "error",
    }, "linux");

    expect(command).toEqual({
      command: "notify-send",
      args: ["--app-name", "Gloomberb", "--urgency", "critical", "Chat mention", "#everyone\n@bob mentioned you"],
    });
  });

  test("builds a Windows notification command", () => {
    const command = buildDesktopNotificationCommand({
      title: "Chat mention",
      body: "@bob mentioned you",
      subtitle: "#everyone",
    }, "win32");

    expect(command?.command).toBe("powershell.exe");
    expect(command?.args[0]).toBe("-NoProfile");
    expect(command?.args.at(-1)).toContain("$notify.BalloonTipTitle = 'Chat mention';");
    expect(command?.args.at(-1)).toContain("$notify.BalloonTipText = '#everyone\n@bob mentioned you';");
  });

  test("adds macOS notification sound when requested", () => {
    const command = buildDesktopNotificationCommand({
      title: "Price alert",
      body: "AAPL triggered",
      sound: "Glass",
    }, "darwin");

    expect(command?.args[1]).toContain("sound name \"Glass\"");
  });
});

describe("notification sound commands", () => {
  test("builds platform sound commands", () => {
    expect(buildSoundCommand("Glass", "darwin")).toEqual({
      command: "afplay",
      args: ["/System/Library/Sounds/Glass.aiff"],
    });
    expect(buildSoundCommand("Ping", "linux")).toEqual({
      command: "paplay",
      args: ["/usr/share/sounds/freedesktop/stereo/message-new-instant.oga"],
    });
    expect(buildSoundCommand("Glass", "win32")?.command).toBe("powershell.exe");
  });
});

describe("app notifier", () => {
  test("shows a toast and sends a desktop notification when inactive", () => {
    const toasts: Array<{ message: string; type?: string; duration?: number }> = [];
    const desktops: string[] = [];
    let active = false;
    const notifier = createAppNotifier({
      isAppActive: () => active,
      renderToast: (notification) => {
        toasts.push({
          message: notification.body,
          type: notification.type,
          duration: notification.duration,
        });
      },
      desktop: {
        notify(notification) {
          desktops.push(notification.body);
        },
      },
    });

    const inactiveDelivery = notifier.notify({
      title: "Chat mention",
      body: "@bob mentioned you",
      type: "info",
      desktop: "when-inactive",
      duration: 5000,
    });

    expect(toasts).toEqual([{ message: "@bob mentioned you", type: "info", duration: 5000 }]);
    expect(desktops).toEqual(["@bob mentioned you"]);
    expect(inactiveDelivery).toEqual({ toastVisible: false, desktopRequested: true });

    active = true;
    const activeDelivery = notifier.notify({
      body: "Visible toast only",
      type: "success",
      desktop: "when-inactive",
    });

    expect(toasts).toEqual([
      { message: "@bob mentioned you", type: "info", duration: 5000 },
      { message: "Visible toast only", type: "success", duration: undefined },
    ]);
    expect(desktops).toEqual(["@bob mentioned you"]);
    expect(activeDelivery).toEqual({ toastVisible: true, desktopRequested: false });
  });

  test("toast-disabled notifications skip toast delivery", () => {
    const toasts: string[] = [];
    const desktops: string[] = [];
    const notifier = createAppNotifier({
      isAppActive: () => false,
      renderToast: (notification) => {
        toasts.push(notification.body);
      },
      desktop: {
        notify(notification) {
          desktops.push(notification.body);
        },
      },
    });

    const delivery = notifier.notify({ body: "Saved", type: "success", toast: false, desktop: "when-inactive" });

    expect(toasts).toEqual([]);
    expect(desktops).toEqual(["Saved"]);
    expect(delivery).toEqual({ toastVisible: false, desktopRequested: true });
  });

  test("does not report an inactive toast as visible delivery without a desktop sink", () => {
    const toasts: string[] = [];
    const notifier = createAppNotifier({
      isAppActive: () => false,
      renderToast: (notification) => {
        toasts.push(notification.body);
      },
      desktop: null,
    });

    const delivery = notifier.notify({ body: "Pending reply", desktop: "when-inactive" });

    expect(toasts).toEqual(["Pending reply"]);
    expect(delivery).toEqual({ toastVisible: false, desktopRequested: false });
  });
});

describe("desktop notifier", () => {
  test("stops retrying a missing desktop notification command", () => {
    const calls: string[] = [];
    const notifier = createDesktopNotifier({
      platform: "linux",
      runner: {
        run(command, _args, handlers) {
          calls.push(command);
          handlers?.onError?.(Object.assign(new Error("missing"), { code: "ENOENT" }));
        },
      },
    });

    const firstDelivery = notifier.notify({ body: "first" });
    const secondDelivery = notifier.notify({ body: "second" });

    expect(calls).toEqual(["notify-send"]);
    expect(firstDelivery).toBe(false);
    expect(secondDelivery).toBe(false);
  });

  test("plays requested sounds alongside desktop notifications", () => {
    const calls: string[] = [];
    const notifier = createDesktopNotifier({
      platform: "linux",
      runner: {
        run(command) {
          calls.push(command);
        },
      },
    });

    const delivery = notifier.notify({ body: "AAPL triggered", sound: "Glass" });

    expect(calls).toEqual(["notify-send", "paplay"]);
    expect(delivery).toBe(true);
  });
});
