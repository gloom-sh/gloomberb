import { apiClient, type CloudEconEventPayload } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
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

export interface EconCalendarFrom {
  events: EconEvent[];
  /** The first UTC day the stored calendar holds; null when it holds nothing. */
  storedFrom: string | null;
}

/**
 * The calendar from a UTC day, with the past events the stored calendar
 * holds. Null from a server that keeps no past events (it answers 404), so
 * the caller reads the current calendar instead.
 */
export async function fetchEconCalendarFrom(from: string): Promise<EconCalendarFrom | null> {
  try {
    const payload = await apiClient.getCloudEconomicCalendarFrom(from);
    if (!payload || !Array.isArray(payload.events) || !(payload.storedFrom === null || /^\d{4}-\d{2}-\d{2}$/.test(String(payload.storedFrom)))) {
      throw new Error("The server returned an unreadable economic calendar");
    }
    return { events: payload.events.map(toEconEvent), storedFrom: payload.storedFrom };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}
