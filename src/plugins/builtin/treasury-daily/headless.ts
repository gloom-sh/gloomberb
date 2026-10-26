import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchTreasuryDaily } from "./client";
import { formatBillions, formatTrillions } from "./model";

const CASH_COLUMNS: HeadlessPaneColumn[] = [
  { key: "account", header: "Treasury General Account" },
  { key: "today", header: "Today $bn", align: "right", description: "The day's figure, billions of dollars", format: formatBillions },
  { key: "month", header: "This month $bn", align: "right", description: "Month to date, billions of dollars", format: formatBillions },
];

const DEBT_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "heldByPublic", header: "Held by public $tn", align: "right", description: "Trillions of dollars", format: formatTrillions },
  { key: "intragovernmental", header: "Intragovernmental $tn", align: "right", description: "Trillions of dollars", format: formatTrillions },
  { key: "total", header: "Total $tn", align: "right", description: "Trillions of dollars", format: formatTrillions },
];

export const treasuryDailyHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  description: "Treasury operating cash for the latest day and public debt for the last 20 business days.",
  argument: { kind: "none" },
  options: [],
  discovery: {
    aliases: ["DTS"],
    dataRequirements: ["Treasury operating cash balance", "Debt to the penny"],
    limitations: [
      "Cash is the latest published day. Balances are millions of dollars, shown in billions.",
      "Debt is the last 20 business days, shown in trillions of dollars.",
      "A balance sent as null was not published.",
    ],
  },
  describe: "Treasury operating cash and public debt",
  freshness: { source: "US Treasury", status: "not-a-feed", basis: "daily statement" },
  async load(_args, ctx) {
    const { cash, debt } = await fetchTreasuryDaily(ctx.signal, { history: false });
    return {
      complete: cash.rows.length > 0 && debt.length > 0,
      sections: [
        {
          title: cash.recordDate ? `Cash ${cash.recordDate}` : "Cash",
          columns: CASH_COLUMNS,
          rows: cash.rows.map((row) => ({
            account: row.account,
            today: row.today,
            month: row.month,
            recordDate: cash.recordDate,
          })),
        },
        {
          title: "Debt",
          columns: DEBT_COLUMNS,
          rows: debt.map((row) => ({
            date: row.date,
            heldByPublic: row.heldByPublic,
            intragovernmental: row.intragovernmental,
            total: row.total,
          })),
        },
      ],
      metadata: {
        asOf: [cash.recordDate, debt[0]?.date ?? null].reduce<string | null>((newest, date) => (
          date && (!newest || date > newest) ? date : newest
        ), null),
        cashRecordDate: cash.recordDate,
        debtRecordDate: debt[0]?.date ?? null,
      },
    };
  },
};
