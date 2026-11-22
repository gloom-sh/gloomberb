import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import type { CloudInsiderFilingStoriesResponse } from "../../../api-client";
import { shortStoryId } from "../../../news/story-id";
import { formatShortDate } from "../../../utils/datetime-format";
import { logFailure } from "../../../utils/log-failure";
import { createTtlCache } from "../../../data/ttl-cache";

/*
 * The stories that report a Form 4, as Gloom Cloud matches them: the filing's
 * owner named in a story about its company's insiders trading, in the months
 * after its trades, the filing among the ones the story's own page lists. What
 * an INS or SEC row names to go from the filing to the news and back.
 */

export interface FilingStory {
  id: string;
  headline: string;
  /** When the story was first published, ISO. */
  publishedAt: string;
  publisher: string;
}

type StoriesClient = Pick<typeof apiClient, "getCloudInsiderFilingStories">;

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
/** As many filings as Gloom Cloud reads in one request; a longer list is asked in several. */
const BATCH = 20;
/**
 * Batches asked at once: a report of 100 filings asks its five requests in
 * three round trips instead of five, and holds no more than two of the few
 * lookups a server works on at a time.
 */
const BATCHES_AT_ONCE = 2;
/** A filing's stories, by accession, for a few minutes: an INS or SEC pane asks again as its rows redraw. */
const cache = createTtlCache<FilingStory[]>({ ttlMs: 5 * 60_000, maxEntries: 500 });

function storiesOf(item: CloudInsiderFilingStoriesResponse["items"][number]): FilingStory[] {
  return (item.stories ?? []).flatMap((story) => (
    story?.id && story.headline
      ? [{ id: story.id, headline: story.headline, publishedAt: story.firstPublishedAt, publisher: story.primaryPublisher ?? "" }]
      : []
  ));
}

/**
 * The stories reporting each filing, by accession number, from a short-lived
 * cache where it has them. A filing Gloom Cloud could not be asked about is
 * left out of the map: no stories said is not "none". The batches are asked
 * BATCHES_AT_ONCE at a time, in the list's order. A batch that fails (a server
 * without the lookup, a session it refuses, a rate or capacity limit) ends
 * the asking without an error: no batch is asked after it, the batches
 * answered beside or before it are kept, and the rows that would have named
 * stories name none.
 */
export async function loadFilingStories(
  accessions: readonly string[],
  client: StoriesClient = apiClient,
): Promise<Map<string, FilingStory[]>> {
  const result = new Map<string, FilingStory[]>();
  const wanted: string[] = [];
  // Asked in batches, one request for a page of rows, so each accession is kept as its answer arrives.
  for (const accession of new Set(accessions)) {
    if (!ACCESSION.test(accession)) continue;
    const hit = cache.peek(accession);
    if (hit) result.set(accession, hit);
    else wanted.push(accession);
  }
  const batches: string[][] = [];
  for (let start = 0; start < wanted.length; start += BATCH) batches.push(wanted.slice(start, start + BATCH));
  let next = 0;
  let refused = false;
  const askInTurn = async () => {
    while (!refused && next < batches.length) {
      const batch = batches[next++]!;
      let response: CloudInsiderFilingStoriesResponse;
      try {
        response = await client.getCloudInsiderFilingStories(batch);
      } catch (error) {
        // The next batch would meet the same refusal: stop, keeping what was answered.
        if (!refused) logFailure("insider.filing-stories", "Read the stories reporting filings failed")(error);
        refused = true;
        return;
      }
      for (const item of response.items ?? []) {
        if (!batch.includes(item.accession)) continue;
        const stories = storiesOf(item);
        cache.set(item.accession, stories);
        result.set(item.accession, stories);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCHES_AT_ONCE, batches.length) }, askInTurn));
  return result;
}

/** The stories reporting one filing, read once it is open; none while they load or when they cannot be read. */
export function useFilingStories(accession: string | null | undefined): FilingStory[] {
  const [state, setState] = useState<{ accession: string; stories: FilingStory[] } | null>(null);
  useEffect(() => {
    if (!accession || !ACCESSION.test(accession)) return;
    let active = true;
    void loadFilingStories([accession])
      .then((found) => {
        if (active) setState({ accession, stories: found.get(accession) ?? [] });
      })
      .catch(logFailure("insider.filing-stories", "Read the stories reporting a filing failed"));
    return () => { active = false; };
  }, [accession]);
  return state && state.accession === accession ? state.stories : [];
}

/** `7 Oct 2026 · Quartz`: when and where a story was first published. */
export function filingStorySource(story: FilingStory): string {
  const day = story.publishedAt ? formatShortDate(story.publishedAt, { utc: true, fallback: "" }) : "";
  return [day, story.publisher].filter(Boolean).join(" · ");
}

/**
 * A story as a report's note names it, with the id `fn story` opens it by:
 * `Story 3224efb6 (7 Oct 2026 · Quartz): Q3 2026 insider stock sales: ...`.
 */
export function filingStoryNote(story: FilingStory): string {
  const source = filingStorySource(story);
  return `Story ${shortStoryId(story.id)}${source ? ` (${source})` : ""}: ${story.headline}`;
}
