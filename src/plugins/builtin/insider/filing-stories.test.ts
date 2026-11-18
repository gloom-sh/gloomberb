import { expect, test } from "bun:test";
import { loadFilingStories } from "./filing-stories";

const accession = (index: number) => `0009900001-26-${String(index).padStart(6, "0")}`;

// `fn INS` / `fn SEC` against a server without the lookup, or one that turns the caller away (401, 429, 503).
test("a batch that fails ends the asking quietly, keeping the batches answered before it", async () => {
  const asked: number[] = [];
  const client = {
    getCloudInsiderFilingStories: async (batch: readonly string[]) => {
      asked.push(batch.length);
      if (asked.length > 1) throw Object.assign(new Error("Too many requests"), { status: 429 });
      return {
        items: batch.map((id, index) => ({
          accession: id,
          stories: index === 0 ? [{ id: "3224efb6-4d68-4526-8ab2-455771f8898a", headline: "Q3 insider sales", firstPublishedAt: "2026-10-07T13:35:57.000Z", lastPublishedAt: "2026-10-07T16:25:00.000Z", primaryPublisher: "Quartz" }] : [],
        })),
      };
    },
  };
  const wanted = Array.from({ length: 45 }, (_, index) => accession(index));
  const found = await loadFilingStories(wanted, client as never);
  // Twenty a request; the second refused, the third never asked.
  expect(asked).toEqual([20, 20]);
  expect(found.size).toBe(20);
  expect(found.get(accession(0))?.map((story) => story.publisher)).toEqual(["Quartz"]);
  expect(found.has(accession(20))).toBe(false);

  // A server without the lookup at all answers nothing, and throws nothing.
  const missing = { getCloudInsiderFilingStories: async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); } };
  expect((await loadFilingStories([accession(100)], missing as never)).size).toBe(0);
});
