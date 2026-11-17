import type { AppNotificationRequest, PaneSettingsDef } from "../../types/plugin";
import { logFailure } from "../../utils/log-failure";
import { isBrowserAppActive } from "./activity";

const PREFERENCE_KEY = "gloomberb:browser-notifications";

interface NotificationApi {
  new(title: string, options: NotificationOptions): Pick<Notification, "onclick" | "close">;
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

interface BrowserNotificationOptions {
  getApi?: () => NotificationApi | undefined;
  getStorage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  isActive?: () => boolean;
  focus?: () => void;
}

export function createBrowserNotifications({
  getApi = () => typeof globalThis.Notification?.requestPermission === "function" ? globalThis.Notification : undefined,
  getStorage = () => window.localStorage,
  isActive = isBrowserAppActive,
  focus = () => window.focus(),
}: BrowserNotificationOptions = {}) {
  function isEnabled(): boolean {
    try {
      return getApi()?.permission === "granted" && getStorage().getItem(PREFERENCE_KEY) === "1";
    } catch (error) {
      logFailure("browser-notifications", "Could not read the browser notification preference")(error);
      return false;
    }
  }

  async function setEnabled(enabled: boolean): Promise<"changed" | "denied" | "dismissed" | "unavailable"> {
    try {
      const storage = getStorage();
      if (!enabled) {
        storage.removeItem(PREFERENCE_KEY);
        return "changed";
      }
      const api = getApi();
      if (!api) return "unavailable";
      const permission = api.permission === "default" ? await api.requestPermission() : api.permission;
      if (permission === "denied") return "denied";
      if (permission !== "granted") return "dismissed";
      storage.setItem(PREFERENCE_KEY, "1");
      return "changed";
    } catch (error) {
      logFailure("browser-notifications", "Could not change the browser notification preference")(error);
      return "unavailable";
    }
  }

  function notify(request: AppNotificationRequest): boolean {
    const api = getApi();
    if (!api || isActive() || !isEnabled() || !request.body.trim()) return false;
    try {
      const banner = new api(request.title?.trim() || "Gloom", {
        body: [request.subtitle, request.body].filter(Boolean).join("\n"),
        tag: request.refId,
        silent: true,
      });
      banner.onclick = () => {
        focus();
        banner.close();
        request.action?.onClick();
      };
      return true;
    } catch (error) {
      logFailure("browser-notifications", "Could not show a browser notification")(error);
      return false;
    }
  }

  return { isSupported: () => !!getApi(), isEnabled, setEnabled, notify };
}

export const browserNotifications = createBrowserNotifications();

export function browserChatSettings(): PaneSettingsDef {
  if (!browserNotifications.isSupported()) return { fields: [] };
  const enabled = browserNotifications.isEnabled();
  return {
    fields: [{
      key: "browserNotifications",
      type: "action",
      actionId: "browser.notifications",
      label: "Browser notifications",
      description: "Alerts when this tab is in the background.",
      actionLabel: enabled ? "Turn off" : "Turn on",
      async action({ setRowNote, notify }) {
        const result = await browserNotifications.setEnabled(!browserNotifications.isEnabled());
        if (result === "changed") return;
        const status = result === "denied" ? "Blocked" : result === "dismissed" ? "Not enabled" : "Unavailable";
        const text = result === "denied" ? "Allow notifications in your browser’s site settings." : undefined;
        if (!setRowNote?.({ status, text, tone: "warning" })) {
          notify({ title: "Browser notifications", body: text ?? status });
        }
      },
    }],
  };
}
