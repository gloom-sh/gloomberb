import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { awardDetailCache, awardsCache, loadAwards, validateAwardDetail, validateAwards } from "./client";
import { awardDetail, awardRow, awardsPayload } from "./test-fixture";

afterEach(() => { awardsCache.reset(); awardDetailCache.reset(); setCloudApiFetchTransport(null); });

test("contract validates exact money, nullable obligations and rejects unsafe evidence and false revenue currencies", () => {
  const valid = awardsPayload({ rows: [awardRow({ awardAmount: "9007199254740993.02", obligatedAmount: null })] });
  expect(validateAwards(valid).rows[0]!.awardAmount).toBe("9007199254740993.02");
  for (const row of [awardRow({ sourceUrl: "javascript:alert(1)" }), awardRow({ awardDate: "2025-02-30" }),
    awardRow({ currency: "GBP" }), awardRow({ confidence: 2 }), awardRow({ awardAmount: "NaN" })]) {
    expect(() => validateAwards(awardsPayload({ rows: [row] }))).toThrow("unreadable government awards");
  }
  expect(() => validateAwards(awardsPayload({ rows: [awardRow(), awardRow()] }))).toThrow();
  expect(() => validateAwardDetail(awardDetail({ revisions: [{ ...awardDetail().revisions[0]!, award: { ...awardRow(), sourceUrl: "file:///tmp/private" } }] }))).toThrow("unreadable award evidence");
});

test("account scoped caching never reuses a full payload for preview and denied refresh refuses cached data", async () => {
  awardsCache.attach(new MemoryPluginPersistence());
  let calls = 0;
  setCloudApiFetchTransport(async () => { calls++; return Response.json(calls === 1 ? awardsPayload() : awardsPayload({ access: "preview", locked: true })); });
  expect((await loadAwards({}, "userA:full")).payload.access).toBe("full");
  expect((await loadAwards({}, "userB:preview")).payload.access).toBe("preview");
  expect(calls).toBe(2);
  setCloudApiFetchTransport(async () => Response.json({ error: "Session expired" }, { status: 401 }));
  await expect(loadAwards({}, "userA:full", true)).rejects.toThrow();
});
