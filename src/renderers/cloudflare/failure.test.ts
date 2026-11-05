import { expect, spyOn, test } from "bun:test";
import { createProxySessionGate } from "./proxy-session";

test("a session check that fails counts the caller as signed out and logs one fixed line without the error", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const gate = createProxySessionGate({ sessionUrl: "https://api.fixture.invalid/session" });
    const request = new Request("https://term.fixture.invalid/api/proxy", {
      headers: { cookie: "__Secure-gloomberb.session_token=private-token", "cf-connecting-ip": "192.0.2.1" },
    });
    const admission = await gate.admit(request, async () => { throw new Error("cookie=private-token account=private"); });
    expect(admission).toEqual({ ok: true, signedIn: false });
    expect(warn.mock.calls).toEqual([["[proxy-session] Could not check the session; the request counts as signed out"]]);
  } finally {
    warn.mockRestore();
  }
});
