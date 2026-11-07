export type AppNotificationType = "info" | "success" | "error";
type AppDesktopNotificationMode = "never" | "when-inactive" | "always";

export interface AppNotificationDelivery {
  toastVisible: boolean;
  desktopRequested: boolean;
}

export interface AppNotificationRequest {
  title?: string;
  body: string;
  subtitle?: string;
  duration?: number;
  type?: AppNotificationType;
  toast?: boolean;
  /** If true, in-app toast stays visible until user dismisses it */
  persistent?: boolean;
  desktop?: AppDesktopNotificationMode;
  /** macOS sound name (e.g., "Glass", "Ping", "Hero"). Ignored on other platforms. */
  sound?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  /**
   * What a built-in notice is about, so the Unread list can keep it after the
   * toast is gone and open it again: `price:<alertId>`, `catalyst:<eventId>`,
   * `econ:<eventId>`, `team:<cardId>` or `scan:<paneId>`. Other values are not kept.
   */
  refId?: string;
  /** Rendered next to `action`. Use for a dismissing counterpart such as snooze. */
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  /** Runs once, when the in-app toast is first drawn. Not called when `toast` is false. */
  onShown?: () => void;
}
