import { afterEach, expect, test } from "bun:test";
import { getWallSummary, parseWallSummary } from "./wall-summary";
import { setCloudApiFetchTransport } from "./request";

afterEach(() => setCloudApiFetchTransport(null));

test("the public summary boundary allows only counts and dates with known labels", () => {
  expect(parseWallSummary({ kind: "counts", items: [{ label: "risk_count", value: 23 }, { label: "filed_at", value: "2026-09-28" }] })).toEqual({
    kind: "counts", items: [{ label: "risk_count", value: 23 }, { label: "filed_at", value: "2026-09-28" }],
  });
  for (const value of [
    undefined,
    { kind: "counts", items: [] },
    { kind: "counts", items: [{ label: "price", value: 120 }] },
    { kind: "counts", items: [{ label: "risk_count", value: "Private disclosure" }] },
    { kind: "counts", items: [{ label: "risk_count", value: -1 }] },
    { kind: "counts", items: [{ label: "risk_count", value: 1.5 }] },
  ]) expect(parseWallSummary(value)).toBeNull();
});


test("public summaries use the installed surface transport and tolerate an empty or older API", async () => {
  const requests: URL[] = [];
  const responses = [
    Response.json({ kind: "counts", items: [{ label: "proxy_count", value: 2 }] }),
    new Response(null, { status: 204 }),
    new Response("Unavailable", { status: 422 }),
  ];
  setCloudApiFetchTransport(async (url) => {
    requests.push(new URL(url));
    return responses.shift()!;
  });
  expect(await getWallSummary("exec-wall", "SHOP", "XNAS")).toEqual({ kind: "counts", items: [{ label: "proxy_count", value: 2 }] });
  expect(await getWallSummary("exec-wall", "SHOP", "XNAS")).toBeNull();
  expect(await getWallSummary("exec-wall", "SHOP", "XNAS")).toBeNull();
  expect(requests.map((url) => `${url.pathname}${url.search}`)).toEqual(Array(3).fill("/public/wall-summary?wall=exec-wall&symbol=SHOP&exchange=NASDAQ"));
});
