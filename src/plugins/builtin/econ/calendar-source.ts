import { apiClient, type CloudEconEventPayload } from "../../../api-client";
import { ApiRequestError, isPermanentClientError } from "../../../api-client/errors";
import type { EconEvent } from "./types";

function toEconEvent(event: CloudEconEventPayload): EconEvent {
  return {
    ...event,
    date: new Date(event.date),
  };
}

export async function fetchEconCalendar(): Promise<EconEvent[]> {
  const events = await apiClient.getCloudEconomicCalendar();
  return events.map(toEconEvent);
}

/** The stored calendar from a day, or why it was not read so the caller reads the current calendar instead. */
export type EconCalendarFrom =
  | {
    events: EconEvent[];
    /** The first UTC day the stored calendar holds; null when it holds nothing. */
    storedFrom: string | null;
  }
  | {
    events: null;
    /** Null from a server that keeps no past events (404); otherwise what went wrong (no network, a server error). */
    failure: string | null;
  };

/**
 * The calendar from a UTC day, with the past events the stored calendar
 * holds. A server that keeps no past events (404), one that fails (5xx, an
 * unreadable answer) and no network all leave `events` null, so `econ`
 * still lists the current calendar. A request the server refuses (422, a
 * date too far back) throws with the server's message.
 */
export async function fetchEconCalendarFrom(from: string): Promise<EconCalendarFrom> {
  try {
    const payload = await apiClient.getCloudEconomicCalendarFrom(from);
    if (!payload || !Array.isArray(payload.events) || !(payload.storedFrom === null || /^\d{4}-\d{2}-\d{2}$/.test(String(payload.storedFrom)))) {
      return { events: null, failure: "the server returned an unreadable calendar" };
    }
    return { events: payload.events.map(toEconEvent), storedFrom: payload.storedFrom };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return { events: null, failure: null };
    if (isPermanentClientError(error)) throw error;
    return { events: null, failure: error instanceof ApiRequestError && error.status ? `server error ${error.status}` : "the server could not be reached" };
  }
}
