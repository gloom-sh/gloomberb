export interface CloudWorldVenuePayload {
  mic: string;
  name: string;
  title: string;
  country: string;
  countryCode: string;
  city: string;
  timezone: string;
  latitude: number;
  longitude: number;
  /** Whether the core session is trading. */
  isOpen: boolean;
  /**
   * The venue's state by its exchange's calendar: the core session `open`, the
   * pre-market or after-hours session a US venue runs around it, `holiday` on a
   * published full-day closure, else `closed`. Absent from an older service.
   */
  session?: WorldVenueSession;
  timeAfterOpenSeconds?: number;
  timeToOpenSeconds?: number;
  timeToCloseSeconds?: number;
  hours?: { open: string; close: string; continuousOpen: string; continuousClose: string };
}

export type WorldVenueSession = "open" | "pre-market" | "after-hours" | "closed" | "holiday";

export interface CloudWorldVenueMapPayload {
  providerId: "gloomberb-cloud";
  checkedAt: number;
  refreshAt: number;
  stale?: boolean;
  venues: CloudWorldVenuePayload[];
}
