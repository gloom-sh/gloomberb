import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../utils/network-failure";

/** What to check when nothing answered: the connection, and the proxy when one is set. */
export function unreachableHint(): string {
  const env = typeof process === "undefined" ? {} : process.env;
  const proxy = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].find((name) => env[name]?.trim());
  return proxy
    ? `Check the internet connection and the proxy in ${proxy}, then try again.`
    : "Check the internet connection, then try again.";
}

/**
 * What a command that answered from saved copies says when the data service
 * went unanswered: the words a command with nothing to show fails with
 * (`unreachableError`), and that what it printed is the copy its source line
 * dates. Offline, DES printed a saved quote as "15 min delayed" and nothing
 * said the service was never reached.
 */
export function savedCopyUnreachableWarning(): string {
  return `${DATA_SERVICE_UNREACHABLE_MESSAGE}, so this is the copy saved earlier. ${unreachableHint()}`;
}
