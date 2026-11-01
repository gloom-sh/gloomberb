/**
 * A request that never reached its server, with `message`: the failure a
 * saved copy answers for (`isTransientFailure`), unlike a plain `Error`, which
 * reads as a reply that failed validation.
 */
export function outage(message = "Unable to connect. Is the computer able to access the url?"): Error {
  return Object.assign(new Error(message), { code: "ConnectionRefused" });
}
