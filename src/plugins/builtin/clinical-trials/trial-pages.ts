import type { PageRequest, RowPage } from "../../../components";
import type { ClinicalTrial, ClinicalTrialsPage, StudiesQuery } from "./client";

/** What one stage of the list asks the registry for on top of the search: a sponsor class to keep or to leave out. */
export type TrialStage = Pick<StudiesQuery, "sponsorClasses" | "excludedSponsorClasses">;

/** The companies' studies first and everything else after them. */
export const COMPANIES_FIRST: readonly TrialStage[] = [{ sponsorClasses: ["INDUSTRY"] }, { excludedSponsorClasses: ["INDUSTRY"] }];

/** Where a page continues: which stage it is in, and the registry's token inside it. */
interface StageCursor {
  stage: number;
  token?: string;
}

/**
 * Pages the registry through `stages` one after the other: a stage's studies
 * come newest first, and when it has no more the next stage starts, so the
 * list reaches a university's study only once the companies' are in. The
 * registry pages by an opaque token, which the next page's offset keys; the
 * first page always starts at the first stage, so a reload starts over. A
 * stage with nothing in it goes straight on to the next, so an empty page is
 * never the end of the list while a stage is left. `onPage` runs on a page's
 * studies before it is handed over.
 */
export function createTrialPageLoader({ list, query, stages, onPage }: {
  list: (query: StudiesQuery, signal: AbortSignal) => Promise<ClinicalTrialsPage>;
  query: StudiesQuery;
  stages: readonly TrialStage[];
  onPage?: (trials: ClinicalTrial[], signal: AbortSignal) => Promise<void>;
}): (request: Pick<PageRequest, "offset" | "signal">) => Promise<RowPage<ClinicalTrial>> {
  const cursors = new Map<number, StageCursor>();
  return async ({ offset, signal }) => {
    let cursor: StageCursor | undefined = offset === 0 ? { stage: 0 } : cursors.get(offset);
    while (cursor) {
      const page: ClinicalTrialsPage = await list({ ...query, ...stages[cursor.stage], pageToken: cursor.token }, signal);
      const next: StageCursor | null = page.nextPageToken ? { stage: cursor.stage, token: page.nextPageToken }
        : cursor.stage + 1 < stages.length ? { stage: cursor.stage + 1 } : null;
      if (page.trials.length === 0 && next && !page.nextPageToken) {
        cursor = next;
        continue;
      }
      const nextOffset = offset + page.trials.length;
      if (next) cursors.set(nextOffset, next);
      await onPage?.(page.trials, signal);
      return { rows: page.trials, hasMore: !!next, nextOffset };
    }
    return { rows: [], hasMore: false };
  };
}
