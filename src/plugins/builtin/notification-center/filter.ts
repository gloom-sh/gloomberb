export type NotificationSourceFilter = "all" | "alerts" | "chat" | "team";

export const NOTIFICATION_CENTER_TEMPLATE_ID = "notification-center-pane";

export function priceAlertIdFromRef(refId: string | undefined): string | null {
  if (!refId?.startsWith("price:")) return null;
  const id = refId.slice("price:".length);
  return id || null;
}

export function catalystEventIdFromRef(refId: string | undefined): string | null {
  if (!refId?.startsWith("catalyst:")) return null;
  const id = refId.slice("catalyst:".length);
  return id || null;
}

/** Chat and team rows carry a refId and are counted on their own chips. */
export function notificationCountsOnStatusBadge(entry: { read: boolean; refId?: string }): boolean {
  if (entry.read) return false;
  if (!entry.refId) return true;
  return priceAlertIdFromRef(entry.refId) != null || catalystEventIdFromRef(entry.refId) != null;
}

export function notificationSourceVisible(source: string, filter: NotificationSourceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "team") return source === "team";
  if (filter === "alerts") return source === "alerts";
  if (filter === "chat") return source === "chat" || source === "gloomberb-cloud";
  return true;
}

/** Raw source ids stay off the screen. */
export function notificationSourceLabel(source: string): string {
  if (source === "alerts") return "Alerts";
  if (source === "chat" || source === "gloomberb-cloud") return "Chat";
  if (source === "team") return "Team";
  return "App";
}
