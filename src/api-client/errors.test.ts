import { expect, test } from "bun:test";
import { parseApiErrorMessage } from "./errors";

test("an HTML error page from the proxy becomes its title, not raw markup", () => {
  const cloudflare = `<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<html><head><title>api.gloom.sh | 502: Bad gateway</title></head><body>...</body></html>`;
  expect(parseApiErrorMessage(cloudflare)).toBe("502: Bad gateway");
  expect(parseApiErrorMessage("<html><body>down</body></html>")).toBe("The server returned an error page.");
  expect(parseApiErrorMessage(JSON.stringify({ error: "Senate PTR filings are unavailable right now." })))
    .toBe("Senate PTR filings are unavailable right now.");
  expect(parseApiErrorMessage("plain text")).toBe("plain text");
});
