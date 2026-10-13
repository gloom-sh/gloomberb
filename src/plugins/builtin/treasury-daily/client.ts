import { httpFetch } from "../../../utils/http-transport";
import { numericOrNull, scalarTextOrNull } from "../../../utils/guards";
import type { CashAccount, DebtDay, OperatingCash } from "./model";

const CASH_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?sort=-record_date&page[size]=40";
const DEBT_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=20";
const FETCH_TIMEOUT_MS = 15_000;
const DEBT_DAYS = 20;

export interface TreasuryDaily {
  cash: OperatingCash;
  debt: DebtDay[];
}

function recordDate(value: unknown): string | null {
  const date = scalarTextOrNull(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function isBusinessDay(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
    throw new Error("Treasury response was not recognized");
  }
  return payload.data.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function parseOperatingCash(payload: unknown): OperatingCash {
  const parsed: Array<CashAccount & { date: string }> = [];
  for (const row of rowsOf(payload)) {
    const date = recordDate(row.record_date);
    const account = scalarTextOrNull(row.account_type);
    if (!date || !account) continue;
    const line = scalarTextOrNull(row.src_line_nbr);
    parsed.push({
      id: `${date}:${line ?? account}`,
      date,
      account,
      // Since the 2022 statement format the day's figures are in open_today_bal
      // and close_today_bal is always "null".
      today: numericOrNull(row.open_today_bal),
      month: numericOrNull(row.open_month_bal),
    });
  }
  const recordDateValue = parsed.reduce<string | null>((latest, row) => (
    latest == null || row.date > latest ? row.date : latest
  ), null);
  return {
    recordDate: recordDateValue,
    rows: parsed.filter((row) => row.date === recordDateValue).map((row) => ({
      id: row.id,
      account: row.account,
      today: row.today,
      month: row.month,
    })),
  };
}

function parseDebtToPenny(payload: unknown): DebtDay[] {
  const byDate = new Map<string, DebtDay>();
  for (const row of rowsOf(payload)) {
    const date = recordDate(row.record_date);
    if (!date || !isBusinessDay(date) || byDate.has(date)) continue;
    byDate.set(date, {
      id: date,
      date,
      heldByPublic: numericOrNull(row.debt_held_public_amt),
      intragovernmental: numericOrNull(row.intragov_hold_amt),
      total: numericOrNull(row.tot_pub_debt_out_amt),
    });
  }
  return [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, DEBT_DAYS);
}

async function readJson(url: string, label: string, signal?: AbortSignal): Promise<unknown> {
  const response = await httpFetch(url, {
    headers: { Accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${label} request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

export async function fetchTreasuryDaily(signal?: AbortSignal): Promise<TreasuryDaily> {
  const [cash, debt] = await Promise.all([
    readJson(CASH_URL, "Treasury cash", signal),
    readJson(DEBT_URL, "Treasury debt", signal),
  ]);
  return { cash: parseOperatingCash(cash), debt: parseDebtToPenny(debt) };
}
