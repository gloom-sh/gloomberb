export const ALERTS_PLUGIN_ID = "alerts";
export const ALERTS_KEY = "alerts";

/** The Alerts pane's tabs: what `ALRT --tab` takes, and the pane state `tab` holds. */
export const ALERT_TABS = [
  { label: "Levels", value: "prices" },
  { label: "Events", value: "events" },
  { label: "History", value: "history" },
];
/** Fallback cadence when the pane's Check interval setting is unset. */
export const POLL_INTERVAL_MS = 30_000;
export const POLL_SECONDS_KEY = "pollSeconds";

/**
 * What delivers a price alert, as docs/usage.md states it: the app checks it on
 * every tick while it runs. Signed in with Cloud sync on, Gloom Cloud also
 * pushes the trigger to a registered phone, and emails it once no app has
 * synced the account for a while, so a rule the app has synced reaches you
 * with the app closed. Signed out, only the running app does. `alerts add`
 * and Add Alert both say it.
 */
export const PRICE_DELIVERY = "the app alerts while it is running; sign in with Cloud sync for email or phone alerts when it is closed";
