import type { AppNotificationRequest } from "../types/plugin";

export function notifyGridlockComplete(
  notify: (notification: AppNotificationRequest) => void,
  onRevert: () => void,
  body = "Tiled all windows",
): void {
  notify({
    body,
    type: "success",
    action: {
      label: "Revert",
      onClick: onRevert,
    },
  });
}
