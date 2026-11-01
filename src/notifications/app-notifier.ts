import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  AppNotificationType,
} from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { appendNotificationLog, markNotificationLogRead } from "./notification-log";

const DEFAULT_NOTIFICATION_TITLE = "Gloom";
const notificationLog = debugLog.createLogger("notifications");

function getRuntimePlatform(): NodeJS.Platform {
  return typeof process !== "undefined" ? process.platform : "linux";
}

export interface DesktopNotificationCommand {
  command: string;
  args: string[];
  /** Added to the environment of the process, for text a command line must not carry. */
  env?: Record<string, string>;
}

interface DesktopNotificationRunOptions {
  env?: Record<string, string>;
  onError?: (error: NodeJS.ErrnoException) => void;
}

export interface DesktopNotificationRunner {
  run(command: string, args: string[], options?: DesktopNotificationRunOptions): void;
}

export interface DesktopNotificationSink {
  notify(notification: AppNotificationRequest): boolean | void;
}

export interface AppNotifier {
  notify(notification: AppNotificationRequest): AppNotificationDelivery;
}

interface CreateAppNotifierOptions {
  isAppActive: () => boolean;
  renderToast: (notification: AppNotificationRequest) => void;
  desktop?: DesktopNotificationSink | null;
}

function escapeAppleScriptString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")}"`;
}

const WINDOWS_NOTIFICATION_TITLE_ENV = "GLOOM_NOTIFICATION_TITLE";
const WINDOWS_NOTIFICATION_TEXT_ENV = "GLOOM_NOTIFICATION_TEXT";
/** The most of a title or a body handed to Windows; a balloon shows far less, and an environment value has a hard limit. */
const WINDOWS_NOTIFICATION_TEXT_LIMIT = 4_000;

/** NUL ends an environment value early, and spawning with one in it fails. */
function windowsEnvText(value: string): string {
  return value.replaceAll("\0", "").slice(0, WINDOWS_NOTIFICATION_TEXT_LIMIT);
}

function mapLinuxUrgency(type: AppNotificationType | undefined): "low" | "normal" | "critical" {
  if (type === "error") return "critical";
  if (type === "success") return "low";
  return "normal";
}

function mapWindowsIcon(type: AppNotificationType | undefined): string {
  if (type === "error") return "Error";
  if (type === "success") return "Information";
  return "Information";
}

function buildLinuxBody(notification: AppNotificationRequest): string | undefined {
  const parts = [notification.subtitle?.trim(), notification.body.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function buildWindowsBody(notification: AppNotificationRequest): string {
  const parts = [notification.subtitle?.trim(), notification.body.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : notification.body.trim();
}

export function buildDesktopNotificationCommand(
  notification: AppNotificationRequest,
  platform: NodeJS.Platform = getRuntimePlatform(),
): DesktopNotificationCommand | null {
  const title = notification.title?.trim() || DEFAULT_NOTIFICATION_TITLE;
  const body = notification.body.trim();
  const subtitle = notification.subtitle?.trim();

  if (!body) {
    return null;
  }

  if (platform === "darwin") {
    const script = [
      `display notification ${escapeAppleScriptString(body)} with title ${escapeAppleScriptString(title)}`,
      subtitle ? `subtitle ${escapeAppleScriptString(subtitle)}` : "",
      notification.sound ? `sound name ${escapeAppleScriptString(notification.sound)}` : "",
    ].filter(Boolean).join(" ");
    return {
      command: "osascript",
      args: ["-e", script],
    };
  }

  if (platform === "linux") {
    const linuxBody = buildLinuxBody(notification);
    return {
      command: "notify-send",
      args: [
        "--app-name",
        DEFAULT_NOTIFICATION_TITLE,
        "--urgency",
        mapLinuxUrgency(notification.type),
        // Text that starts with `-` is the title or the body, not an option.
        "--",
        title,
        ...(linuxBody ? [linuxBody] : []),
      ],
    };
  }

  if (platform === "win32") {
    // The script is the same for every notification. The title and the text
    // reach it in the environment of the process, where PowerShell reads them
    // as plain strings and never as code, whatever characters they hold.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$notify = New-Object System.Windows.Forms.NotifyIcon;",
      `$notify.Icon = [System.Drawing.SystemIcons]::${mapWindowsIcon(notification.type)};`,
      `$notify.BalloonTipTitle = $env:${WINDOWS_NOTIFICATION_TITLE_ENV};`,
      `$notify.BalloonTipText = $env:${WINDOWS_NOTIFICATION_TEXT_ENV};`,
      "$notify.Visible = $true;",
      "$notify.ShowBalloonTip(5000);",
      "Start-Sleep -Seconds 6;",
      "$notify.Dispose();",
    ].join(" ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      env: {
        [WINDOWS_NOTIFICATION_TITLE_ENV]: windowsEnvText(title),
        [WINDOWS_NOTIFICATION_TEXT_ENV]: windowsEnvText(buildWindowsBody(notification)),
      },
    };
  }

  return null;
}

function defaultDesktopNotificationRunner(
  command: string,
  args: string[],
  options?: DesktopNotificationRunOptions,
): void {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    try {
      const child = Bun.spawn([command, ...args], {
        stdio: ["ignore", "ignore", "ignore"],
        ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      });
      child.unref();
    } catch (error) {
      options?.onError?.(error as NodeJS.ErrnoException);
    }
    return;
  }

  options?.onError?.(Object.assign(new Error("Desktop notifications require a native process host."), {
    code: "ENOSYS",
  }) as NodeJS.ErrnoException);
}

export function buildSoundCommand(
  soundName: string,
  platform: NodeJS.Platform = getRuntimePlatform(),
): DesktopNotificationCommand | null {
  if (platform === "darwin") {
    return {
      command: "afplay",
      args: [`/System/Library/Sounds/${soundName}.aiff`],
    };
  }

  if (platform === "linux") {
    const soundFile = soundName === "Glass" ? "dialog-information"
      : soundName === "Ping" ? "message-new-instant"
      : soundName === "Hero" ? "dialog-warning"
      : "bell";
    return {
      command: "paplay",
      args: [`/usr/share/sounds/freedesktop/stereo/${soundFile}.oga`],
    };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", "[System.Media.SystemSounds]::Beep.Play()"],
    };
  }

  return null;
}

export function createDesktopNotifier(
  options: {
    platform?: NodeJS.Platform;
    runner?: DesktopNotificationRunner;
  } = {},
): DesktopNotificationSink {
  const platform = options.platform ?? getRuntimePlatform();
  const runner = options.runner ?? { run: defaultDesktopNotificationRunner };
  let disabledCommand: string | null = null;

  return {
    notify(notification) {
      const desktopCommand = buildDesktopNotificationCommand(notification, platform);
      let desktopRequested = false;
      if (desktopCommand && disabledCommand !== desktopCommand.command) {
        let requestFailed = false;
        runner.run(desktopCommand.command, desktopCommand.args, {
          env: desktopCommand.env,
          onError: (error) => {
            requestFailed = true;
            if (error.code === "ENOENT") {
              disabledCommand = desktopCommand.command;
            }
            notificationLog.warn("desktop notification failed", {
              command: desktopCommand.command,
              code: error.code,
              message: error.message,
            });
          },
        });
        desktopRequested = !requestFailed;
      }

      if (notification.sound) {
        const soundCommand = buildSoundCommand(notification.sound, platform);
        if (soundCommand) {
          runner.run(soundCommand.command, soundCommand.args, {
            onError: (error) => {
              notificationLog.warn("sound playback failed", {
                command: soundCommand.command,
                code: error.code,
                message: error.message,
              });
            },
          });
        }
      }

      return desktopRequested;
    },
  };
}

export function createAppNotifier({
  isAppActive,
  renderToast,
  desktop = typeof Bun !== "undefined" ? createDesktopNotifier() : null,
}: CreateAppNotifierOptions): AppNotifier {
  return {
    notify(request) {
      // A missed price, catalyst, economic release or team notice waits in the
      // Unread list; using its toast action means it was seen.
      const logged = appendNotificationLog(request);
      const notification: AppNotificationRequest = logged && request.action
        ? {
          ...request,
          action: {
            ...request.action,
            onClick: () => {
              markNotificationLogRead([logged.id]);
              request.action?.onClick();
            },
          },
        }
        : request;
      const appActive = isAppActive();
      const toastEnabled = notification.toast !== false;
      const desktopMode = notification.desktop ?? "never";
      let toastRendered = false;
      let desktopRequested = false;

      if (toastEnabled) {
        renderToast(notification);
        toastRendered = true;
      }

      if (
        desktopMode === "always" ||
        (desktopMode === "when-inactive" && !appActive)
      ) {
        desktopRequested = desktop ? desktop.notify(notification) !== false : false;
      }

      return {
        toastVisible: appActive && toastRendered,
        desktopRequested,
      };
    },
  };
}
