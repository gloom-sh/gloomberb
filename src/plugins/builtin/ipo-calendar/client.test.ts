import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { IpoCalendarParams, IpoCalendarPayload, IpoDeal } from "../../../api-client/ipo";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { fetchIpoCalendar, validateIpoCalendar } from "./client";
import { ipoCalendarHeadless } from "./headless";
import { ipoDeal } from "./test-fixture";

const board = (deals: unknown[], sources: unknown[] = []) => ({ asOf: "2026-09-29T00:00:00Z", deals, sources }) as IpoCalendarPayload;

/**
 * The server keeps adding venues and fields. A deal the pane cannot read is
 * left out, not allowed to take the whole board down with it, while a venue
 * or region this build has never heard of still shows.
 */
test("one unreadable deal is left out, and a new venue or region still shows", () => {
  const payload = validateIpoCalendar(board([
    ipoDeal({ id: "arm" }),
    { ...ipoDeal({ id: "bad-status" }), status: "suspended" },
    { ...ipoDeal({ id: "bad-price" }), offerPrice: "18" },
    ipoDeal({ id: "tadawul", mic: "XSAU", exchange: null, region: "mena" as IpoDeal["region"] }),
  ], [
    { id: "nasdaq", mics: ["XNAS"], ok: true, asOf: "2026-09-29T00:00:00Z" },
    { id: "broken", mics: "XNSE", ok: false, asOf: null },
  ]));
  expect(payload.deals.map((deal) => [deal.id, deal.region])).toEqual([["arm", "us"], ["tadawul", "other"]]);
  expect(payload.sources.map((source) => source.id)).toEqual(["nasdaq"]);
  expect(() => validateIpoCalendar({ deals: [] } as unknown as IpoCalendarPayload)).toThrow("unreadable IPO calendar");
});

test("a server without the route, or before its first pass, says the calendar is not there yet", async () => {
  for (const status of [404, 503]) {
    const client = { getCloudIpoCalendar: async () => { throw new ApiRequestError("Not deployed", status); } };
    await expect(fetchIpoCalendar(client)).rejects.toThrow("The IPO calendar is not available on this server yet.");
  }
});

/** The server's default window leaves filed and withdrawn deals out, so the CLI asks for a stage by name. */
test("the CLI asks the server for the stage it filters on", async () => {
  const asked: IpoCalendarParams[] = [];
  const ctx = {
    apiClient: {
      getCloudIpoCalendar: async (params: IpoCalendarParams) => {
        asked.push(params);
        return board([ipoDeal({ id: "filed", status: "filed" }), ipoDeal({ id: "upcoming" })]);
      },
    },
  } as unknown as HeadlessPaneContext;
  const load = (options: Record<string, unknown>) => ipoCalendarHeadless.load({ rawArgument: "", argument: null, symbols: [], options }, ctx);

  expect((await load({ status: "filed" })).rows.map((row) => row.id)).toEqual(["filed"]);
  expect((await load({})).rows.map((row) => row.id)).toEqual(["upcoming", "filed"]);
  expect(asked).toEqual([{ status: "filed" }, {}]);
});
