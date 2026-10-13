import { apiClient } from "../../../../../api-client";
import type { Letter, LetterKind, LettersParams, LettersPayload } from "../../../../../api-client/letters";
import type { PageLoader } from "../../../../../components";
import type { HeadlessPaneApiClient } from "../../../../../types/plugin";
import { unavailableOnServer } from "../../../shared/cloud-resource";
import { DATE_BASIS_LABELS, isOwnKey, LETTER_KIND_LABELS } from "./model";

/** A changed or broken answer becomes an error state, never a wrong row. */
class UnreadableLetters extends Error {
  constructor() {
    super("The server returned unreadable letters");
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const isFilled = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
/** A real calendar day: `2026-02-30` is not one, even though Date would roll it over. */
const isDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const isIntIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
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
    && isOwnKey(LETTER_KIND_LABELS, value.kind)
    && isDay(value.date) && isOwnKey(DATE_BASIS_LABELS, value.date_basis) && isWebUrl(value.url);
}

/** The route's own bounds: a page of 1 to 200 at an offset up to 2,000, never more items than its limit. */
const MAX_LIMIT = 200;
/** The route refuses an offset past this; a list stops paging there. */
const MAX_OFFSET = 2_000;

export function parseLetters(value: unknown): LettersPayload {
  if (!isObject(value) || !Array.isArray(value.items) || !value.items.every(validLetter)
    || typeof value.hasMore !== "boolean" || !isIntIn(value.limit, 1, MAX_LIMIT) || !isIntIn(value.offset, 0, MAX_OFFSET)
    || value.items.length > value.limit) {
    throw new UnreadableLetters();
  }
  return {
    items: value.items.map((item) => ({
      id: item.id, title: item.title, entity: item.entity, kind: item.kind, date: item.date,
      date_basis: item.date_basis, url: item.url,
    })),
    hasMore: value.hasMore,
    limit: value.limit as number,
    offset: value.offset as number,
  };
}

const PAGE_LIMIT = 50;
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

/**
 * One page loader per set of kinds (null: every kind): a new set starts the
 * list over, so offsets always count within the set asked for. A page
 * for another offset than the one asked for is unreadable, and a page with no
 * rows ends the list whatever it says, so paging can never spin in place.
 */
export function letterPageLoader(kinds: readonly LetterKind[] | null, client: LettersApi = apiClient): PageLoader<LetterPage> {
  return async ({ offset, signal }) => {
    const payload = await fetchLetters({ ...(kinds ? { kinds } : {}), limit: PAGE_LIMIT, offset }, client, signal);
    if (payload.offset !== offset) throw new UnreadableLetters();
    const nextOffset = offset + payload.items.length;
    return {
      rows: payload.items,
      hasMore: payload.hasMore && payload.items.length > 0 && nextOffset <= MAX_OFFSET,
      nextOffset,
    };
  };
}
