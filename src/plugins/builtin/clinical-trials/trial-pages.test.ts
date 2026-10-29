import { describe, expect, test } from "bun:test";
import type { ClinicalTrial, ClinicalTrialsPage, StudiesQuery } from "./client";
import { COMPANIES_FIRST, createTrialPageLoader } from "./trial-pages";

const trial = (nctId: string) => ({ nctId }) as ClinicalTrial;
const signal = new AbortController().signal;

/** A registry with a queue of answers per stage: `industry` for the companies' studies, `rest` for the others. */
function registry(answers: { industry: ClinicalTrialsPage[]; rest: ClinicalTrialsPage[] }) {
  const asked: StudiesQuery[] = [];
  const queues = { industry: [...answers.industry], rest: [...answers.rest] };
  const list = async (query: StudiesQuery): Promise<ClinicalTrialsPage> => {
    asked.push(query);
    const next = (query.sponsorClasses ? queues.industry : queues.rest).shift();
    if (!next) throw new Error("asked for a page there is none of");
    return next;
  };
  return { asked, list };
}

const page = (ids: string[], nextPageToken: string | null = null): ClinicalTrialsPage => ({ trials: ids.map(trial), nextPageToken });

describe("the companies' studies page first", () => {
  test("a stage's pages continue by token, then the next stage starts, and the last one ends the list", async () => {
    const { asked, list } = registry({
      industry: [page(["i1", "i2"], "t1"), page(["i3"])],
      rest: [page(["r1"], "t2"), page(["r2"])],
    });
    const load = createTrialPageLoader({ list, query: { term: "obesity", pageSize: 2 }, stages: COMPANIES_FIRST });

    expect(await load({ offset: 0, signal })).toEqual({ rows: [trial("i1"), trial("i2")], hasMore: true, nextOffset: 2 });
    expect(await load({ offset: 2, signal })).toEqual({ rows: [trial("i3")], hasMore: true, nextOffset: 3 });
    expect(await load({ offset: 3, signal })).toEqual({ rows: [trial("r1")], hasMore: true, nextOffset: 4 });
    expect(await load({ offset: 4, signal })).toEqual({ rows: [trial("r2")], hasMore: false, nextOffset: 5 });

    expect(asked.map((query) => [query.sponsorClasses, query.excludedSponsorClasses, query.pageToken, query.term])).toEqual([
      [["INDUSTRY"], undefined, undefined, "obesity"],
      [["INDUSTRY"], undefined, "t1", "obesity"],
      [undefined, ["INDUSTRY"], undefined, "obesity"],
      [undefined, ["INDUSTRY"], "t2", "obesity"],
    ]);
  });

  test("a stage with no studies goes straight on, so the list is never empty while the other stage has some", async () => {
    const { list } = registry({ industry: [page([])], rest: [page(["r1"])] });
    const load = createTrialPageLoader({ list, query: {}, stages: COMPANIES_FIRST });
    expect(await load({ offset: 0, signal })).toEqual({ rows: [trial("r1")], hasMore: false, nextOffset: 1 });
  });

  test("a reload starts at the first stage again, and a page of an offset it never handed out is empty", async () => {
    const { asked, list } = registry({ industry: [page(["i1"]), page(["i1"])], rest: [page(["r1"])] });
    const load = createTrialPageLoader({ list, query: {}, stages: COMPANIES_FIRST });
    await load({ offset: 0, signal });
    await load({ offset: 1, signal });
    expect(await load({ offset: 0, signal })).toMatchObject({ rows: [trial("i1")], hasMore: true });
    expect(asked.at(-1)?.sponsorClasses).toEqual(["INDUSTRY"]);
    expect(await load({ offset: 99, signal })).toEqual({ rows: [], hasMore: false });
  });

  test("one stage pages through the registry as it is, and each page is handed to onPage before it shows", async () => {
    const { asked, list } = registry({ industry: [], rest: [page(["r1"], "t1"), page(["r2"])] });
    const seen: string[][] = [];
    const load = createTrialPageLoader({
      list,
      query: { statuses: ["RECRUITING"] },
      stages: [{}],
      onPage: async (trials) => { seen.push(trials.map((entry) => entry.nctId)); },
    });
    expect((await load({ offset: 0, signal })).hasMore).toBe(true);
    expect((await load({ offset: 1, signal })).hasMore).toBe(false);
    expect(seen).toEqual([["r1"], ["r2"]]);
    expect(asked.every((query) => !query.sponsorClasses && !query.excludedSponsorClasses && query.statuses?.[0] === "RECRUITING")).toBe(true);
  });
});
