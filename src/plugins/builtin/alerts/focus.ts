import { createListenerSet } from "../../../utils/listeners";

let pendingPriceAlertId: string | null = null;
const listeners = createListenerSet();

/** Open on the Prices tab should select this rule once the table is up. */
export function requestPriceAlertFocus(alertId: string): void {
  pendingPriceAlertId = alertId;
  listeners.notify();
}

export function getPriceAlertFocus(): string | null {
  return pendingPriceAlertId;
}

export function clearPriceAlertFocus(): void {
  if (!pendingPriceAlertId) return;
  pendingPriceAlertId = null;
  listeners.notify();
}

export const subscribePriceAlertFocus = listeners.subscribe;
