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
