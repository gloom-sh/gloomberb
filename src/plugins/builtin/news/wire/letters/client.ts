import { apiClient } from "../../../../../api-client";
import type { Letter, LetterKind, LettersParams, LettersPayload } from "../../../../../api-client/letters";
import type { PageLoader } from "../../../../../components";
import type { HeadlessPaneApiClient } from "../../../../../types/plugin";
import { unavailableOnServer } from "../../../shared/cloud-resource";
import { LETTER_KIND_LABELS } from "./model";

/** A changed or broken answer becomes an error state, never a wrong row. */
class UnreadableLetters extends Error {
  constructor() {
    super("The server returned unreadable letters");
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const isFilled = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
/** Only web links are opened; a letter whose link is anything else is unreadable. */
const isWebUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

function validLetter(value: unknown): value is Letter {
  return isObject(value) && isFilled(value.id) && isFilled(value.title) && isFilled(value.entity)
    && typeof value.kind === "string" && value.kind in LETTER_KIND_LABELS
    && isDay(value.date) && isWebUrl(value.url);
}

export function parseLetters(value: unknown): LettersPayload {
  if (!isObject(value) || !Array.isArray(value.items) || !value.items.every(validLetter)
    || typeof value.hasMore !== "boolean" || !isCount(value.limit) || !isCount(value.offset)) {
    throw new UnreadableLetters();
  }
  return {
    items: value.items.map((item) => ({
      id: item.id, title: item.title, entity: item.entity, kind: item.kind, date: item.date, url: item.url,
    })),
    hasMore: value.hasMore,
    limit: value.limit as number,
    offset: value.offset as number,
  };
}

const PAGE_LIMIT = 50;
/** The route refuses an offset past this; a list stops paging there. */
const MAX_OFFSET = 2_000;
const UNAVAILABLE = "Letters are not available right now.";

type LettersApi = Pick<HeadlessPaneApiClient, "getPublicLetters">;

export async function fetchLetters(
  params: LettersParams,
  client: LettersApi = apiClient,
  signal?: AbortSignal,
): Promise<LettersPayload> {
  let raw: unknown;
  try {
    raw = await client.getPublicLetters(params, { signal });
  } catch (error) {
    throw unavailableOnServer(error, UNAVAILABLE);
  }
  return parseLetters(raw);
}

export interface LetterPage {
  rows: Letter[];
  hasMore: boolean;
  nextOffset: number;
}

/** One page loader per kind filter: a new kind starts the list over. */
export function letterPageLoader(kind: LetterKind | null, client: LettersApi = apiClient): PageLoader<LetterPage> {
  return async ({ offset, signal }) => {
    const payload = await fetchLetters({ ...(kind ? { kind } : {}), limit: PAGE_LIMIT, offset }, client, signal);
    const nextOffset = offset + payload.items.length;
    return { rows: payload.items, hasMore: payload.hasMore && nextOffset <= MAX_OFFSET, nextOffset };
  };
}
