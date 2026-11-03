import { expect, test } from "bun:test";
import { scriptForWebview } from "./script-for-webview";

// A script queued for a webview that closed can reach a new one at the same
// native address; there its RPC answers would settle the wrong requests.
test("a script for one webview does nothing in another", () => {
  const script = scriptForWebview(3, [
    `window.__electrobun.receiveMessageFromHost({"type":"response","id":1});`,
    `window.__electrobun.receiveMessageFromHost({"type":"response","id":2});`,
  ].join("\n"));
  const run = (webviewId: number | undefined) => {
    const received: unknown[] = [];
    const page = { __electrobunWebviewId: webviewId, __electrobun: { receiveMessageFromHost: (message: unknown) => received.push(message) } };
    new Function("window", script)(page);
    return received;
  };
  expect(run(3)).toEqual([{ type: "response", id: 1 }, { type: "response", id: 2 }]);
  expect(run(4)).toEqual([]);
  // A page whose preload has not run yet.
  expect(run(undefined)).toEqual([]);
});
