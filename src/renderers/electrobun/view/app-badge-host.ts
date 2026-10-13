import { installAppBadgeHost } from "../../../notifications/app-badge";
import { backendRequest } from "./backend-rpc";

/**
 * Lets the unread count reach the Dock icon. The view cannot call native
 * APIs, so the label goes to the Bun process, which sets the badge for the
 * platform. Installed for the main window only: a popped-out pane's window has
 * a chat state of its own and no say in the app's badge.
 */
export function installElectrobunAppBadgeHost(): () => void {
  return installAppBadgeHost({
    setBadge: (label) => {
      // A failed badge is not worth an error; the next change sets it again.
      void backendRequest("host.setAppBadge", { label }).catch(() => {});
    },
  });
}
