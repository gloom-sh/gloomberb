import type { HttpFetchTransport } from "../../../utils/http-transport";

/** A Yahoo transport past the cookie and crumb handshake; `route` answers the chart and summary requests. */
export function yahooTransport(route: (url: string) => Response | Promise<Response>): HttpFetchTransport {
  return async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    return route(url);
  };
}

/** A Yahoo chart response holding one close at `time` and the given dividend events. */
export function chartResponse({ meta, time, close = 100, dividends }: {
  meta: Record<string, unknown>;
  time: number;
  close?: number;
  dividends: Record<string, unknown>;
}): Response {
  return Response.json({ chart: { result: [{
    meta, timestamp: [time], indicators: { quote: [{ close: [close] }] }, events: { dividends },
  }] } });
}
