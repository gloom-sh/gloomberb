import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  AppNotificationType,
} from "../types/plugin";
import { debugLog } from "../utils/debug-log";

const DEFAULT_NOTIFICATION_TITLE = "Gloomberb";
const notificationLog = debugLog.createLogger("notifications");

function getRuntimePlatform(): NodeJS.Platform {
  return typeof process !== "undefined" ? process.platform : "linux";
}

export interface DesktopNotificationCommand {
  command: string;
  args: string[];
}

export interface DesktopNotificationRunner {
  run(
    command: string,
    args: string[],
    handlers?: { onError?: (error: NodeJS.ErrnoException) => void },
  ): void;
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

function escapePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
        title,
        ...(linuxBody ? [linuxBody] : []),
      ],
    };
  }

  if (platform === "win32") {
    const balloonBody = buildWindowsBody(notification);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$notify = New-Object System.Windows.Forms.NotifyIcon;",
      `$notify.Icon = [System.Drawing.SystemIcons]::${mapWindowsIcon(notification.type)};`,
      `$notify.BalloonTipTitle = ${escapePowerShellString(title)};`,
      `$notify.BalloonTipText = ${escapePowerShellString(balloonBody)};`,
      "$notify.Visible = $true;",
      "$notify.ShowBalloonTip(5000);",
      "Start-Sleep -Seconds 6;",
      "$notify.Dispose();",
    ].join(" ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    };
  }

  return null;
}

function defaultDesktopNotificationRunner(
  command: string,
  args: string[],
  handlers?: { onError?: (error: NodeJS.ErrnoException) => void },
): void {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    try {
      const child = Bun.spawn([command, ...args], { stdio: ["ignore", "ignore", "ignore"] });
      child.unref();
    } catch (error) {
      handlers?.onError?.(error as NodeJS.ErrnoException);
    }
    return;
  }

  handlers?.onError?.(Object.assign(new Error("Desktop notifications require a native process host."), {
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
    notify(notification) {
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
