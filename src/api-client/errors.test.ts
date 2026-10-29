import { expect, test } from "bun:test";
import { ApiRequestError, isTransientFailure, parseApiErrorMessage } from "./errors";
import { DataServiceUnreachableError } from "../utils/network-failure";

test("an HTML error page from the proxy or a schema refusal becomes words, not raw markup or the payload", () => {
  const cloudflare = `<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<html><head><title>api.gloom.sh | 502: Bad gateway</title></head><body>...</body></html>`;
  expect(parseApiErrorMessage(cloudflare)).toBe("502: Bad gateway");
  expect(parseApiErrorMessage("<html><body>down</body></html>")).toBe("The server returned an error page.");
  expect(parseApiErrorMessage(JSON.stringify({ error: "Senate PTR filings are unavailable right now." })))
    .toBe("Senate PTR filings are unavailable right now.");
  expect(parseApiErrorMessage("plain text")).toBe("plain text");
  // A schema refusal echoes the query it was sent, never a message.
  expect(parseApiErrorMessage(JSON.stringify({ type: "validation", on: "query", found: { from: "14/10/2026", limit: "100" } })))
    .toBe("Gloom Cloud did not accept an option or filter value.");
});

// A saved copy answers only for these: a refusal or a validation failure hidden behind it reads as current data.
test("a saved copy may answer for no connection, a drop, a timeout, 408, 429 and 5xx, never for another 4xx or a validation failure", () => {
  const refused = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
  const transient = [new DataServiceUnreachableError(refused), refused, Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
    new DOMException("took too long", "TimeoutError"), new ApiRequestError("timeout", 408), new ApiRequestError("slow down", 429),
    new ApiRequestError("bad gateway", 502), new ApiRequestError("upstream", 400, undefined, "retryable_error"),
    new Error("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })];
  for (const error of transient) expect(isTransientFailure(error)).toBe(true);
  const refusals = [new ApiRequestError("gone", 404), new ApiRequestError("sign in", 401), new ApiRequestError("pro", 402),
    new ApiRequestError("bad option", 400), new Error("Unexpected FRED series identity or units"), new SyntaxError("Unexpected token <")];
  for (const error of refusals) expect(isTransientFailure(error)).toBe(false);
});
