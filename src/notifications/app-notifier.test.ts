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
      args: ["--app-name", "Gloom", "--urgency", "critical", "--", "Chat mention", "#everyone\n@bob mentioned you"],
    });
  });

  test("passes Linux notification text after `--`, so a leading dash is text", () => {
    const command = buildDesktopNotificationCommand({ title: "--hint=int:x:1", body: "-u critical" }, "linux");

    expect(command?.args).toEqual(["--app-name", "Gloom", "--urgency", "normal", "--", "--hint=int:x:1", "-u critical"]);
  });

  test("keeps notification text out of the Windows command line", () => {
    const title = "It\u2019s \u2018a\u201A \u201Bb' $(calc) `x` \"q\" ; & | %PATH%\nline";
    const body = "\u2019; Remove-Item -Recurse C:\\ ; '\u2018 $(Start-Process calc)\r\n'--";
    const command = buildDesktopNotificationCommand({ title, body, subtitle: "#all\u2019 ; calc" }, "win32");

    expect(command?.command).toBe("powershell.exe");
    expect(command?.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    const argv = command!.args.join("\n");
    for (const fragment of ["\u2018", "\u2019", "\u201A", "\u201B", "'a", "$(", "calc", "Remove-Item", "PATH", "line", "#all"]) {
      expect(argv).not.toContain(fragment);
    }
    expect(command?.env).toEqual({
      GLOOM_NOTIFICATION_TITLE: title,
      GLOOM_NOTIFICATION_TEXT: `#all\u2019 ; calc\n${body}`,
    });
    expect(command?.args.at(-1)).toContain("$notify.BalloonTipTitle = $env:GLOOM_NOTIFICATION_TITLE;");
    expect(command?.args.at(-1)).toContain("$notify.BalloonTipText = $env:GLOOM_NOTIFICATION_TEXT;");
  });

  test("runs one Windows script for every notification", () => {
    const script = (title: string) => buildDesktopNotificationCommand({ title, body: "x" }, "win32")?.args.at(-1);

    expect(script("a")).toBe(script("b\u2019; calc"));
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
        run(command, _args, options) {
          calls.push(command);
          options?.onError?.(Object.assign(new Error("missing"), { code: "ENOENT" }));
        },
      },
    });

    const firstDelivery = notifier.notify({ body: "first" });
    const secondDelivery = notifier.notify({ body: "second" });

    expect(calls).toEqual(["notify-send"]);
    expect(firstDelivery).toBe(false);
    expect(secondDelivery).toBe(false);
  });

  test("hands the notification text to the runner as environment, not arguments", () => {
    const runs: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const notifier = createDesktopNotifier({
      platform: "win32",
      runner: { run: (_command, args, options) => { runs.push({ args, env: options?.env }); } },
    });

    notifier.notify({ title: "T\u2019; calc", body: "B\u2018; calc" });

    expect(runs).toHaveLength(1);
    expect(runs[0]!.args.join(" ")).not.toContain("calc");
    expect(runs[0]!.env).toEqual({ GLOOM_NOTIFICATION_TITLE: "T\u2019; calc", GLOOM_NOTIFICATION_TEXT: "B\u2018; calc" });
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
