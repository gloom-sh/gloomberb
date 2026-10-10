import { expect, test } from "bun:test";
import type { CloudBeneficialOwnersParams } from "../../../api-client/beneficial-owners";
import { ApiRequestError } from "../../../api-client/errors";
import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";
import { fetchBeneficialOwners } from "./beneficial-client";
import { CAR_BENEFICIAL_OWNERS } from "./test-fixture";

function pagedClient(pages: Array<Record<string, unknown>>) {
  const requests: CloudBeneficialOwnersParams[] = [];
  return {
    requests,
    client: {
      getCloudSecBeneficialOwners: async (params: CloudBeneficialOwnersParams) => {
        requests.push(params);
        return pages[requests.length - 1] as never;
      },
    },
  };
}

test("follows nextOffset across pages, drops overlap and unreadable reports, and keeps missing numbers missing", async () => {
  const [first, second, third] = CAR_BENEFICIAL_OWNERS;
  const { client, requests } = pagedClient([
    { ticker: "CAR", asOf: "2026-10-09T08:00:00Z", owners: [first, second], hasMore: true, nextOffset: 2 },
    {
      ticker: "CAR", asOf: "2026-10-09T08:00:01Z",
      owners: [second, { ...third, percentOfClass: "5.6", shares: null, newField: 1 }, { filerName: "No accession" }],
      hasMore: true, nextOffset: 2,
    },
  ]);
  const payload = await fetchBeneficialOwners("car", { form: "13G" }, { client });
  expect(requests.map(({ offset, form, ticker }) => [ticker, form, offset])).toEqual([["CAR", "13G", 0], ["CAR", "13G", 2]]);
  expect(payload.owners.map((owner) => owner.filerName)).toEqual([first!.filerName, second!.filerName, third!.filerName]);
  expect(payload.owners[2]).toMatchObject({ percentOfClass: null, shares: null, newField: 1 });
  // A page that does not move the offset ends the walk instead of looping on it.
  expect(payload.hasMore).toBe(true);
});

test("a refused session asks for sign-in and a missing ticker says the filings are not available", async () => {
  const failing = (status: number) => ({
    getCloudSecBeneficialOwners: async () => { throw new ApiRequestError("refused", status); },
  });
  await expect(fetchBeneficialOwners("CAR", {}, { client: failing(401) })).rejects.toThrow(CLOUD_SESSION_REQUIRED);
  await expect(fetchBeneficialOwners("ZZZZ", {}, { client: failing(404) }))
    .rejects.toThrow("13D/13G filings are not available for ZZZZ.");
});
