let pendingPriceAlertId: string | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Open on the Prices tab should select this rule once the table is up. */
export function requestPriceAlertFocus(alertId: string): void {
  pendingPriceAlertId = alertId;
  publish();
}

export function getPriceAlertFocus(): string | null {
  return pendingPriceAlertId;
}

export function clearPriceAlertFocus(): void {
  if (!pendingPriceAlertId) return;
  pendingPriceAlertId = null;
  publish();
}

export function subscribePriceAlertFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
