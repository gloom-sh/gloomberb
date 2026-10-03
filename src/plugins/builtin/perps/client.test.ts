import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { cachedPerps, loadPerps, perpsCache, validatePerpsBoard, validatePerpsHistory } from "./client";
import { perpBoard, perpHistory, perpRow } from "./test-fixture";

test("boundary refuses invalid intervals, non-finite funding and duplicate identities while retaining null baselines", () => {
  expect(validatePerpsBoard(perpBoard()).rows[0]!.oiChange24h).toBeNull();
  for (const row of [perpRow({ fundingIntervalHours: 0 }), perpRow({ fundingRate: NaN }), perpRow({ observedAt: "invalid" })]) {
    expect(() => validatePerpsBoard(perpBoard({ rows: [row] }))).toThrow("unreadable");
  }
  expect(() => validatePerpsBoard(perpBoard({ rows: [perpRow(), perpRow()] }))).toThrow("unreadable");
  expect(validatePerpsHistory(perpHistory({ locked: true, access: "preview" })).rows).toEqual([]);
});

test("paid caches are isolated per account/plan and failures preserve data except access refusal", async () => {
  perpsCache.reset();
  const board = perpBoard();
  const request = spyOn(apiClient, "getCloudPerpsBoard").mockResolvedValue(board);
  try {
    await loadPerps("account-a:pro");
    expect(cachedPerps("account-b:preview")).toBeNull();
    request.mockRejectedValue(new ApiRequestError("Gateway unavailable", 502));
    expect(await loadPerps("account-a:pro", true)).toMatchObject({ payload: board, stale: true, refreshError: "Gateway unavailable" });
    request.mockRejectedValue(new ApiRequestError("Session expired", 401));
    await expect(loadPerps("account-a:pro", true)).rejects.toThrow("Session expired");
  } finally { request.mockRestore(); perpsCache.reset(); }
});
