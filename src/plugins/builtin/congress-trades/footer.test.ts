import { expect, test } from "bun:test";
import { formatDetailDate } from "../../../utils/datetime-format";
import { congressFreshnessFooter, latestCongressFiling } from "./footer";
import { loadCongressHouse } from "./client";

test("a refresh does not date the filings and visible rows need not be sorted by filing date", () => {
  const asOf = "2026-11-19T15:30:00Z";
  const fetchedAt = "2026-11-20T03:10:00Z";
  const latest = latestCongressFiling([{ filingDate: "2026-10-22" }, { filingDate: "2026-11-10" }]);
  const labels = (payload: { asOf: string; fetchedAt?: string }) => congressFreshnessFooter(payload, latest).map((segment) => segment.parts[0]?.text);
  expect(labels({ asOf, fetchedAt })).toEqual(["latest filing 10 Nov 2026", `fetched ${formatDetailDate(fetchedAt)}`]);
  expect(labels({ asOf })).toEqual(["latest filing 10 Nov 2026", `fetched ${formatDetailDate(asOf)}`]);
});

test("an exchange-qualified US ticker still requests only that ticker's filings", async () => {
  const stop = new Error("request captured");
  await expect(loadCongressHouse({ ticker: "XLE:ARCX" }, {
    getCloudCongressHouse: (params) => {
      expect(params?.ticker).toBe("XLE");
      return Promise.reject(stop);
    },
  })).rejects.toBe(stop);
});
