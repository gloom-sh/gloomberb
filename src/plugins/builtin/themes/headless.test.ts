import { afterEach, expect, setSystemTime, test } from "bun:test";
import { THEME_PERIODS, type ThemeMember, type ThemeMembersPayload, type ThemeSummary, type ThemesPayload } from "../../../api-client/themes";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/headless";
import { themesHeadless } from "./headless";

afterEach(() => setSystemTime());

const theme: ThemeSummary = { id: "defense", name: "Defense & aerospace", description: "", keywords: ["defense"], memberCount: 2, present: 2, stale: false,
  returns: Object.fromEntries(THEME_PERIODS.map((period) => [period, { value: 1, covered: 2, total: 2 }])) as ThemeSummary["returns"],
  breadth: { value: 50, covered: 2, total: 2 }, best: { symbol: "LMT", changePercent: 0.33 }, worst: { symbol: "HII", changePercent: -0.08 } };
const member = (symbol: string, price: number, extra: Partial<ThemeMember> = {}): ThemeMember => ({
  symbol, name: symbol, exchange: "NYSE", present: true, price, ...Object.fromEntries(THEME_PERIODS.map((period) => [period, 1])),
  asOf: Object.fromEntries(["price", ...THEME_PERIODS].map((field) => [field, "2026-10-09"])), stale: false, ...extra,
}) as ThemeMember;

async function load(metadata: Partial<ThemesPayload>, members: ThemeMember[], argument = "defense") {
  const base = { asOf: new Date(Date.now() - 12 * 60_000).toISOString(), snapshotId: "s", stale: false, ...metadata };
  const apiClient = {
    getCloudThemes: async (): Promise<ThemesPayload> => ({ ...base, themes: [theme] }),
    getCloudThemeMembers: async (): Promise<ThemeMembersPayload> => ({ ...base, theme, members }),
  };
  const args = { symbols: [], argument: argument ? [argument] : [], rawArgument: argument, options: {} } as unknown as HeadlessPaneLoadArgs;
  const result = await themesHeadless.load(args, { signal: new AbortController().signal, apiClient, refresh: false } as unknown as HeadlessPaneContext) as HeadlessRowsResult;
  return { result, line: formatFreshnessLine(deriveHeadlessFreshness(themesHeadless, result, Date.now())) };
}

const closed = { session: "CLOSED" as const, regularSessionDate: "2026-10-09", regularSessionClosedAt: Date.UTC(2026, 9, 9, 20) };
const lmt = member("LMT", 509.59, { changePercent: 0.33, extendedSession: "POST", extendedPrice: 510.19, extendedChange: 0.6, extendedChangePercent: 0.12 });

test("outside the regular session the report is as of the close with the snapshot's age, and an after-hours print gets its own column", async () => {
  // Sunday 11 Oct 2026 19:47 UTC, a snapshot put together 12 minutes before.
  setSystemTime(new Date("2026-10-11T19:47:00Z"));
  const { result, line } = await load(closed, [lmt, member("HII", 264.8)]);
  expect(line).toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon · snapshot 12m ago");
  expect(result.metadata).toMatchObject({ asOf: "2026-10-09T20:00:00.000Z", snapshotAssembledAt: "2026-10-11T19:35:00.000Z", snapshotAgeMinutes: 12,
    regularSessionDate: "2026-10-09", snapshotId: "s", stale: false });
  expect(result.columns?.map((column) => column.header)).toEqual(["Ticker", "Name", "Price $", "1D", "After Hours", "1W", "1M", "3M", "YTD vs 31 Dec close"]);
  const after = result.columns!.find((column) => column.header === "After Hours")!;
  const [hii, row] = result.rows;
  expect(after.format!(row!.extendedPrice, row!)).toBe("510.19 +0.12%");
  expect(after.format!(hii!.extendedPrice, hii!)).toBe("--");
  expect(hii).toMatchObject({ symbol: "HII", extendedSession: null, extendedPrice: null, extendedChangePercent: null });
  // The board of themes is dated the same way.
  expect((await load(closed, [], "")).line).toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon · snapshot 12m ago");
});

test("a snapshot over 30 minutes old, a trading session and an older server date the report by the snapshot", async () => {
  setSystemTime(new Date("2026-10-11T19:47:00Z"));
  expect((await load({ ...closed, asOf: "2026-10-11T19:05:00.000Z" }, [lmt])).line).toBe("Source: Gloom Cloud · Sun 11 Oct 2026 19:05 UTC · stale (42 min old)");
  // An older server sends no session, members without an extended print: the report reads as it did.
  const older = await load({}, [member("LMT", 510.19)]);
  expect(older.line).toBe("Source: Gloom Cloud · Sun 11 Oct 2026 19:35 UTC · 15 min delayed");
  expect(older.result.columns?.map((column) => column.header)).not.toContain("After Hours");
  setSystemTime(new Date("2026-10-12T15:47:00Z"));
  expect((await load({ session: "REGULAR", regularSessionDate: null, regularSessionClosedAt: null }, [member("LMT", 512)])).line)
    .toBe("Source: Gloom Cloud · Mon 12 Oct 2026 15:35 UTC · 15 min delayed");
});

test("the title names the basket shown, and the word that matched it when that is not the basket's name", async () => {
  const title = async (argument: string) => {
    const { result } = await load({}, [member("LMT", 510)], argument);
    const args = { symbols: [], argument: [argument], rawArgument: argument, options: {} } as unknown as HeadlessPaneLoadArgs;
    return typeof themesHeadless.describe === "function" ? themesHeadless.describe(args, result) : themesHeadless.describe;
  };
  expect(await title("defense")).toBe("Thematic baskets | Defense & aerospace");
  // "lithium" opens Critical minerals: the title says so rather than claim a lithium basket.
  expect(await title("aerospace")).toBe("Thematic baskets | Defense & aerospace (matched aerospace)");
});
