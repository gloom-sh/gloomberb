import { afterEach, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { fetchTreasuryDaily } from "./client";
import { cashLineLabel, formatBillions, tgaClosesInRange } from "./model";

// Shapes captured from the live operating_cash_balance and debt_to_penny endpoints on 2026-10-23.
const CASH = { data: [
  { record_date: "2026-10-22", account_type: "Treasury General Account (TGA) Opening Balance", open_today_bal: "945153", open_month_bal: "984046", src_line_nbr: "1" },
  { record_date: "2026-10-22", account_type: "Total TGA Deposits (Table II)", open_today_bal: "301418", open_month_bal: "2594630", src_line_nbr: "2" },
  { record_date: "2026-10-22", account_type: "Total TGA Withdrawals (Table II) (-)", open_today_bal: "284812", open_month_bal: "2616916", src_line_nbr: "3" },
  { record_date: "2026-10-22", account_type: "Treasury General Account (TGA) Closing Balance", open_today_bal: "961759", open_month_bal: "961759", src_line_nbr: "4" },
] };
const DEBT = { data: [{ record_date: "2026-10-22", debt_held_public_amt: "32600000000000", intragov_hold_amt: "7850000000000", tot_pub_debt_out_amt: "40440000000000" }] };
const closing = (date: string, millions: string) => ({ record_date: date, open_today_bal: millions });

afterEach(() => setHttpFetchTransport(null));

function serve(history: () => Response) {
  const urls: string[] = [];
  setHttpFetchTransport(async (url) => {
    urls.push(url);
    if (url.includes("debt_to_penny")) return Response.json(DEBT);
    return url.includes("filter=") ? history() : Response.json(CASH);
  });
  return urls;
}

test("cash lines read plainly, and a billion-dollar figure carries thousands separators", async () => {
  serve(() => Response.json({ data: [] }));
  const { cash } = await fetchTreasuryDaily();
  expect(cash.rows.map((row) => row.account)).toEqual(["Opening balance", "Deposits", "Withdrawals", "Closing balance"]);
  expect(formatBillions(cash.rows[1]!.month)).toBe("2,594.63");
  expect(formatBillions(945_153)).toBe("945.15");
  expect(formatBillions(-0.2)).toBe("0.00");
  // A line the statement adds later keeps its own words, less the table reference.
  expect(cashLineLabel("Total Other Deposits (Table II) (-)")).toBe("Total Other Deposits");
});

test("the closing balance history is one filtered request, read oldest first, and its failure leaves the figures", async () => {
  const urls = serve(() => Response.json({ data: [closing("2026-10-22", "961759"), closing("2026-10-21", "945153"), closing("2026-10-21", "1"), closing("2026-10-20", "null")] }));
  const daily = await fetchTreasuryDaily();
  expect(daily.tga).toEqual([{ date: "2026-10-21", millions: 945_153 }, { date: "2026-10-22", millions: 961_759 }]);
  expect(urls.filter((url) => url.includes("filter="))).toHaveLength(1);
  expect(decodeURIComponent(urls.find((url) => url.includes("filter="))!.replaceAll("+", " "))).toContain("account_type:eq:Treasury General Account (TGA) Closing Balance");

  // A report that does not draw the history does not ask for it.
  expect((await fetchTreasuryDaily(undefined, { history: false })).tga).toEqual([]);
  expect(urls.filter((url) => url.includes("filter="))).toHaveLength(1);

  serve(() => new Response("unavailable", { status: 503 }));
  const failed = await fetchTreasuryDaily();
  expect(failed.cash.rows).toHaveLength(4);
  expect(failed).toMatchObject({ tga: [], tgaError: "Treasury account history request failed (503)" });
});

test("a range counts back whole months from the newest close", () => {
  const closes = ["2025-10-22", "2026-04-22", "2026-07-21", "2026-07-22", "2026-10-22"].map((date) => ({ date, millions: 1 }));
  expect(tgaClosesInRange(closes, "3M").map((close) => close.date)).toEqual(["2026-07-22", "2026-10-22"]);
  expect(tgaClosesInRange(closes, "6M").map((close) => close.date)).toEqual(["2026-04-22", "2026-07-21", "2026-07-22", "2026-10-22"]);
  expect(tgaClosesInRange(closes, "ALL")).toHaveLength(5);
});
