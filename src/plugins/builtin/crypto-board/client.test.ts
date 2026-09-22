import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchCryptoBoard, validateCryptoBoard } from "./client";
import { cryptoFixture } from "./test-fixture";
test("crypto Cloud boundary preserves quoted zero-volume history and rejects mixed currencies, missing timestamps and compressed dates", () => {
  const data = cryptoFixture();
  data.rows[0]!.history[3] = { ...data.rows[0]!.history[3]!, volume: 0, tradeCount: 0, status: "quote-only" };
  expect(validateCryptoBoard(data).rows[0]!.history[3]!.close).toBe(103);
  const mutations = [
    (copy: typeof data) => {
      copy.rows[0]!.volume.unit = "USD";
    },
    (copy: typeof data) => {
      copy.rows[0]!.price.asOf = null;
    },
    (copy: typeof data) => {
      copy.rows[0]!.history.splice(4, 1);
    },
    (copy: typeof data) => {
      copy.rows[0]!.price.percentile.sampleCount = 19;
    },
    (copy: typeof data) => {
      copy.rows[0]!.history[3]!.volume = 1;
    },
    (copy: typeof data) => {
      copy.rows[0]!.return7d.startDate = "2026-09-15";
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(data);
    mutate(copy);
    expect(() => validateCryptoBoard(copy)).toThrow();
  }
});
test("absent crypto endpoint has a concise availability error", async () => {
  const error = new ApiRequestError("Not found", 404);
  await expect(
    fetchCryptoBoard({
      getCloudCryptoBoard: async () => {
        throw error;
      },
    }),
  ).rejects.toThrow("not available");
  await expect(
    fetchCryptoBoard({
      getCloudCryptoBoard: async () => {
        throw new ApiRequestError("Unavailable", 503);
      },
    }),
  ).rejects.toThrow("temporarily unavailable");
});
