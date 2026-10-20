import { afterEach, expect, test } from "bun:test";
import { createTestCliContext } from "../../../../../test-support/cli-context";
import { setHttpFetchTransport } from "../../../../../utils/http-transport";
import { rssCliCommand } from "./cli";

afterEach(() => setHttpFetchTransport(null));

test.each([
  ["unavailable", 503, "Temporarily unavailable"],
  ["malformed", 200, "<html><body>Proxy error</body></html>"],
  ["truncated", 200, "<rss><channel><item><title>Incomplete"],
] as const)("rss fetch fails when the feed is %s instead of printing an empty success", async (_label, status, body) => {
  setHttpFetchTransport(async () => new Response(body, { status }));
  const cli = createTestCliContext();

  await expect(rssCliCommand.execute(["fetch", "https://rss-cli.example/feed"], cli.context))
    .rejects.toThrow("1 of 1 RSS feeds unavailable.");
  expect(cli.printed).toEqual([]);
});

test.each([
  ["RSS", '<rss version="2.0"><channel/></rss>'],
  ["Atom", '<feed xmlns="http://www.w3.org/2005/Atom"/>'],
])("rss fetch still succeeds for a valid empty %s feed", async (_label, body) => {
  setHttpFetchTransport(async () => new Response(body));
  const cli = createTestCliContext();

  await rssCliCommand.execute(["fetch", "https://rss-cli.example/empty"], cli.context);

  expect(cli.printed).toHaveLength(1);
  expect(cli.printed[0]!.result).toEqual({ data: [] });
  expect(cli.printed[0]!.options?.empty).toBe("The feed has no items.");
});
