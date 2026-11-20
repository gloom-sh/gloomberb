import { expect, test } from "bun:test";
import { isLocalRequest, isOwnPageSocket, newLaunchSecret, secretRoute } from "./local-guard";

const PORT = 41_234;
const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:${PORT}${path}`, {
  headers: { host: `127.0.0.1:${PORT}`, ...headers },
});

// The desktop stand-in answers config.save and http.fetch over its socket, so
// a website open beside a benchmark must reach none of it.
test("only the benchmark's own page, under its launch's secret folder, reaches a stand-in", () => {
  const secret = newLaunchSecret();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  const own = { origin: `http://127.0.0.1:${PORT}` };

  expect(secretRoute(request(`/${secret}/`), PORT, secret)).toBe("/");
  expect(secretRoute(request(`/${secret}/__warm-heap`), PORT, secret)).toBe("/__warm-heap");
  expect(secretRoute(request(`/${secret}/main.js`, own), PORT, secret)).toBe("/main.js");

  // Without the folder, with another launch's, or a prefix of it.
  expect(secretRoute(request("/__warm-requests"), PORT, secret)).toBeNull();
  expect(secretRoute(request(`/${newLaunchSecret()}/__warm-requests`), PORT, secret)).toBeNull();
  expect(secretRoute(request(`/${secret.slice(0, 32)}/`), PORT, secret)).toBeNull();
  // Another page, or a name rebound to this address.
  expect(secretRoute(request(`/${secret}/`, { origin: "https://example.com" }), PORT, secret)).toBeNull();
  expect(secretRoute(request(`/${secret}/`, { host: `rebound.example:${PORT}` }), PORT, secret)).toBeNull();
  expect(isLocalRequest(request("/", { host: `localhost:${PORT}` }), PORT)).toBe(false);
  expect(isLocalRequest(request("/"), undefined)).toBe(false);

  // A socket names the page that opened it: only the server's own.
  expect(isOwnPageSocket(request("/", own), PORT)).toBe(true);
  expect(isOwnPageSocket(request("/"), PORT)).toBe(false);
  expect(isOwnPageSocket(request("/", { origin: "https://example.com" }), PORT)).toBe(false);
});
