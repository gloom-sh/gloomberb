import { expect, test } from "bun:test";
import type { CloudInsiderFilingStoriesResponse } from "../../../api-client";
import { loadFilingStories } from "./filing-stories";

const accession = (index: number) => `0009900001-26-${String(index).padStart(6, "0")}`;

const answerFor = (batch: readonly string[]): CloudInsiderFilingStoriesResponse => ({
  items: batch.map((id, index) => ({
    accession: id,
    stories: index === 0 ? [{ id: "3224efb6-4d68-4526-8ab2-455771f8898a", headline: "Q3 insider sales", firstPublishedAt: "2026-10-07T13:35:57.000Z", lastPublishedAt: "2026-10-07T16:25:00.000Z", primaryPublisher: "Quartz" }] : [],
  })),
});

interface HeldBatch {
  batch: readonly string[];
  answer(): void;
  refuse(error: Error): void;
}

/** A client whose batches answer only when the test says, so the order of the answers is the test's. */
function heldClient() {
  const asked: HeldBatch[] = [];
  const client = {
    getCloudInsiderFilingStories: (batch: readonly string[]) => new Promise<CloudInsiderFilingStoriesResponse>((resolve, reject) => {
      asked.push({ batch, answer: () => resolve(answerFor(batch)), refuse: reject });
    }),
  };
  return { asked, client };
}

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

// `fn INS` with 100 filings waited for five lookups one after another.
test("asks two batches at a time in the list's order, and keeps every answer whichever comes first", async () => {
  const { asked, client } = heldClient();
  const loading = loadFilingStories(Array.from({ length: 100 }, (_, index) => accession(index)), client as never);
  await settle();
  expect(asked.map(({ batch }) => batch[0])).toEqual([accession(0), accession(20)]);
  // The second answers first: the third goes out in its place, never a third at once.
  asked[1]!.answer();
  await settle();
  expect(asked.map(({ batch }) => batch[0])).toEqual([accession(0), accession(20), accession(40)]);
  for (let index = 0; index < 5; index += 1) {
    if (index !== 1) asked[index]!.answer();
    await settle();
  }
  const found = await loading;
  expect(asked.map(({ batch }) => batch.length)).toEqual([20, 20, 20, 20, 20]);
  expect(found.size).toBe(100);
  expect(found.get(accession(20))?.map((story) => story.publisher)).toEqual(["Quartz"]);
  expect(found.get(accession(21))).toEqual([]);
});

// `fn INS` / `fn SEC` against a server without the lookup, or one that turns the caller away (401, 429, 503).
test("a batch that fails ends the asking quietly: none is asked after it, and the batches answered beside it are kept", async () => {
  const { asked, client } = heldClient();
  const loading = loadFilingStories(Array.from({ length: 45 }, (_, index) => accession(200 + index)), client as never);
  await settle();
  asked[1]!.refuse(Object.assign(new Error("Too many requests"), { status: 429 }));
  await settle();
  asked[0]!.answer();
  const found = await loading;
  // Twenty a request; the second refused, the third never asked.
  expect(asked.map(({ batch }) => batch.length)).toEqual([20, 20]);
  expect(found.size).toBe(20);
  expect(found.get(accession(200))?.map((story) => story.publisher)).toEqual(["Quartz"]);
  expect(found.has(accession(220))).toBe(false);

  // A server without the lookup at all answers nothing, and throws nothing.
  const missing = { getCloudInsiderFilingStories: async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); } };
  expect((await loadFilingStories([accession(300)], missing as never)).size).toBe(0);
});
