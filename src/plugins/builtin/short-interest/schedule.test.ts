import { expect, test } from "bun:test";
import { shortInterestFreshness, shortInterestSchedule, shortInterestScheduleText } from "./schedule";

// FINRA's published 2026 calendar: settlement, then publication seven business days later.
const FINRA_2026: Array<[settlement: string, published: string, nextSettlement: string]> = [
  ["2026-09-15", "2026-09-24", "2026-09-30"],
  ["2026-09-30", "2026-10-09", "2026-10-15"],
  ["2026-10-15", "2026-10-26", "2026-10-30"],
  // 31 October is a Saturday: the month's last business day is the 30th.
  ["2026-10-30", "2026-11-10", "2026-11-13"],
  // 15 November is a Sunday: the settlement is the Friday before.
  ["2026-11-13", "2026-11-24", "2026-11-30"],
  ["2026-11-30", "2026-12-09", "2026-12-15"],
  ["2026-12-15", "2026-12-24", "2026-12-31"],
  // New Year's Day is not a business day, so seven of them end on the 12th.
  ["2026-12-31", "2027-01-12", "2027-01-15"],
];

test("settlements are published seven business days later, and the next one is the 15th or the last business day", () => {
  for (const [settlement, published, nextSettlement] of FINRA_2026) {
    expect(shortInterestSchedule(settlement), settlement).toMatchObject({ published, nextSettlement });
  }
  // The history the SI report lists agrees with the rule, a settlement at a time: a Sunday 15th, a holiday Monday, a month with 28 days.
  expect(shortInterestSchedule("2026-03-13")?.nextSettlement).toBe("2026-03-31");
  expect(shortInterestSchedule("2026-02-13")?.nextSettlement).toBe("2026-02-27");
  expect(shortInterestSchedule("2026-01-30")?.nextSettlement).toBe("2026-02-13");
  expect(shortInterestSchedule("2026-09-30")?.nextPublished).toBe("2026-10-26");
  // Good Friday (3 April 2026) and Memorial Day (25 May) are not business days.
  expect(shortInterestSchedule("2026-03-31")?.published).toBe("2026-04-10");
  expect(shortInterestSchedule("2026-05-15")?.published).toBe("2026-05-27");
});

test("the line says what could be read when, with the year only where it differs from the settlement's", () => {
  expect(shortInterestFreshness("2026-09-30")).toEqual({
    schedule: "published Fri 9 Oct, next settlement Thu 15 Oct, published Mon 26 Oct",
    publishedAt: "2026-10-09",
  });
  expect(shortInterestScheduleText(shortInterestSchedule("2026-12-31")!))
    .toBe("published Tue 12 Jan 2027, next settlement Fri 15 Jan 2027, published Wed 27 Jan 2027");
  // A date that is not a calendar day is not guessed at.
  expect(shortInterestFreshness("2026-02-30")).toBeUndefined();
  expect(shortInterestFreshness(null)).toBeUndefined();
});
