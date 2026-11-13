import { expect, test } from "bun:test";
import { listedHeadline, listedRowHeadline, newsSummaryLine, routineNoticeFields, summaryRestatesHeadline } from "./news-model";

test("a summary that says its headline again in other words is left out; one that adds the why or the numbers stays", () => {
  // Stories as a ticker's feed served them on 2026-11-06.
  expect(summaryRestatesHeadline("Apple seeks about $7 billion from bond sale, Bloomberg News reports",
    "Apple is seeking to raise about $7 billion through a bond sale, Bloomberg News reports.")).toBe(true);
  expect(summaryRestatesHeadline("EXCLUSIVE: Apple's predictive text restrictions include 'Dictator Trump' and 'Sleepy Joe,' researcher finds",
    "A researcher found that Apple's predictive text feature restricts phrases including \u201cDictator Trump\u201d and \u201cSleepy Joe.\u201d")).toBe(true);
  expect(summaryRestatesHeadline("Apple has been outperforming. But, the good times could soon end, Daiwa says",
    "Daiwa says Apple\u2019s recent outperformance may not last, raising a cautionary outlook on the stock.")).toBe(false);
  expect(newsSummaryLine({ title: "Fed holds rates steady",
    summary: "The Federal Reserve kept its benchmark rate at 3.75%-4% and signaled\n two more cuts next year." }))
    .toBe("The Federal Reserve kept its benchmark rate at 3.75%-4% and signaled two more cuts next year.");
  expect(newsSummaryLine({ title: "Apple shares jump to all-time high", summary: "Apple shares jumped to an all-time high." })).toBeNull();
});

test("a folded row of routine notices says how many since when, naming the year only when the run crossed one", () => {
  const notice = { title: "Transaction in own shares", publishedAt: new Date("2026-11-10T18:19:26.000Z") };
  const routine = (since: string | Date, notices = 8) => ({ kind: "buyback", notices, since: since as Date, programme: null });
  expect(listedHeadline({ ...notice, routine: routine(new Date("2026-10-30T18:32:16.000Z")) }))
    .toBe("Transaction in own shares (8 notices since 30 Oct)");
  expect(listedHeadline({ ...notice, publishedAt: new Date("2027-01-06T18:00:00.000Z"), routine: routine(new Date("2026-12-15T18:00:00.000Z")) }))
    .toBe("Transaction in own shares (8 notices since 15 Dec 2026)");
  // One notice is no fold, and a row with no `routine` is its title.
  expect(listedHeadline({ ...notice, routine: routine(new Date("2026-11-10T18:19:26.000Z"), 1) })).toBe("Transaction in own shares");
  expect(listedHeadline(notice)).toBe("Transaction in own shares");
  // A day kept as text, as a pane's restored state had it, is read as a day; an unreadable one names none.
  expect(listedHeadline({ ...notice, routine: routine("2026-10-30T18:32:16.000Z") })).toBe("Transaction in own shares (8 notices since 30 Oct)");
  expect(listedHeadline({ ...notice, routine: routine("not a day") })).toBe("Transaction in own shares (8 notices)");
});

test("an exported row keeps the story's title and the notices apart; the text table puts them back together", () => {
  const article = { title: "Transaction in own shares", publishedAt: new Date("2026-11-10T18:19:26.000Z"),
    routine: { kind: "buyback", notices: 8, since: new Date("2026-10-30T18:32:16.000Z"), programme: "buy-back announced on 2026-10-28" } };
  const fields = routineNoticeFields(article);
  expect(fields).toEqual({ routineKind: "buyback", routineNotices: 8, routineSince: "2026-10-30T18:32:16.000Z",
    routineProgramme: "buy-back announced on 2026-10-28" });
  const row = { title: article.title, publishedAt: article.publishedAt.toISOString(), ...fields };
  expect(listedRowHeadline(row.title, row)).toBe("Transaction in own shares (8 notices since 30 Oct)");
  expect(listedRowHeadline("Fed holds rates steady", { publishedAt: row.publishedAt })).toBe("Fed holds rates steady");
  expect(routineNoticeFields({})).toEqual({});
});
