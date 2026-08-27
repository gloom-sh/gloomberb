import type { AppNotificationRequest } from "../types/plugin";

export function notifyGridlockComplete(
  notify: (notification: AppNotificationRequest) => void,
  onRevert: () => void,
  body = "Windows tidied",
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
