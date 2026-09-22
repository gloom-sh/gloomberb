import { expect, test } from "bun:test";
import { cryptoBoardRow, cryptoNotices, cryptoPrice, currentCryptoRow } from "./model";
import { cryptoFixture } from "./test-fixture";
test("cached crypto trades age independently of stored freshness and preserve completed UTC metrics", () => {
  const row = cryptoFixture().rows[0]!;
  const stale = currentCryptoRow(row, Date.parse("2026-09-22T12:31:00Z"));
  expect(stale.price.freshness).toBe("stale");
  expect(stale.price.asOf).toBe(row.price.asOf);
  const expired = currentCryptoRow(row, Date.parse("2026-09-24T12:00:00Z"));
  expect(expired.price.value).toBeNull();
  expect(expired.price.percentile.value).toBeNull();
  expect(expired.dailyChange.valuePercent).toBeNull();
  expect(expired.return7d).toEqual(row.return7d);
  expect(expired.volume).toEqual(row.volume);
  expect(row.price.value).toBe(125);
});
test("sub-cent prices retain visible precision, short samples are marked and sparse history keeps its actual dates", () => {
  expect(cryptoPrice(0.00000604)).toBe("0.00000604");
  const data = cryptoFixture(),
    row = data.rows[0]!;
  row.history[3] = {
    date: row.history[3]!.date,
    close: null,
    volume: null,
    tradeCount: null,
    status: "missing",
  };
  const board = cryptoBoardRow(row, Date.parse(row.asOf!));
  expect(board.history).toHaveLength(24);
  expect(board.history[3]!.date.toISOString().slice(0, 10)).toBe(row.history[4]!.date);
  expect(board.percentileText).toBe("60*");
  expect(cryptoNotices(data, Date.parse(row.asOf!)).some((notice) => notice.includes("25 observed"))).toBe(
    true,
  );
});
