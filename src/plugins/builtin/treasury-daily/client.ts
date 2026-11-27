import { ApiRequestError, sourceDidNotAnswer } from "../../../api-client/errors";
import { OperationTimeoutError, signalWithTimeout } from "../../../utils/async-deadline";
import { readCalendarDate } from "../../../utils/calendar-date";
import { httpFetch } from "../../../utils/http-transport";
import { numericOrNull, scalarTextOrNull } from "../../../utils/guards";
import { cashLineLabel, type CashAccount, type DebtDay, type OperatingCash, type TgaClose } from "./model";

const CASH_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?sort=-record_date&page[size]=40";
// One line of the statement, every day since it took its present form in 2022: about a thousand closes.
const TGA_CLOSING_ACCOUNT = "Treasury General Account (TGA) Closing Balance";
const TGA_HISTORY_URL = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?${new URLSearchParams({
  filter: `account_type:eq:${TGA_CLOSING_ACCOUNT}`,
  fields: "record_date,open_today_bal",
  sort: "-record_date",
  "page[size]": "3000",
})}`;
const DEBT_URL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=20";
const FETCH_TIMEOUT_MS = 15_000;
const DEBT_DAYS = 20;

export interface TreasuryDaily {
  cash: OperatingCash;
  debt: DebtDay[];
  /** The Treasury General Account's closing balance each day, oldest first. Empty when it could not be read, with the reason. */
  tga: TgaClose[];
  tgaError?: string;
}

function recordDate(value: unknown): string | null {
  const date = scalarTextOrNull(value);
  return date && readCalendarDate(date) === date ? date : null;
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
      account: cashLineLabel(account),
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

function parseTgaHistory(payload: unknown): TgaClose[] {
  const byDate = new Map<string, number>();
  for (const row of rowsOf(payload)) {
    const date = recordDate(row.record_date);
    // The closing balance is sent in open_today_bal, as the statement's other lines are.
    const millions = numericOrNull(row.open_today_bal);
    if (date && millions != null && !byDate.has(date)) byDate.set(date, millions);
  }
  return [...byDate].map(([date, millions]) => ({ date, millions })).sort((a, b) => a.date.localeCompare(b.date));
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

/**
 * One statement read, bounded whoever asks: a caller's signal (a command's)
 * ends it sooner, never later, so a source that does not answer is an error
 * in seconds rather than whenever its gateway gives up.
 */
async function readJson(url: string, label: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
  const deadline = signalWithTimeout(signal, timeoutMs);
  try {
    deadline.throwIfAborted();
    const response = await httpFetch(url, { headers: { Accept: "application/json" }, signal: deadline });
    if (!response.ok) throw new ApiRequestError(`${label} request failed (${response.status})`, response.status);
    const payload = await response.json() as unknown;
    deadline.throwIfAborted();
    return payload;
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new OperationTimeoutError(`${label} request timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw error;
  }
}

const readCash = (signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS) => readJson(CASH_URL, "Treasury cash", signal, timeoutMs);
const readDebt = (signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS) => readJson(DEBT_URL, "Treasury debt", signal, timeoutMs);
const readTga = (signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS) => readJson(TGA_HISTORY_URL, "Treasury account history", signal, timeoutMs).then(parseTgaHistory);

export async function fetchTreasuryCash(signal: AbortSignal, timeoutMs?: number): Promise<OperatingCash> {
  const cash = parseOperatingCash(await readCash(signal, timeoutMs));
  if (!cash.rows.some(({ today, month }) => today !== null || month !== null)) throw sourceDidNotAnswer("No published cash figures received");
  return cash;
}

export async function fetchTreasuryDebt(signal: AbortSignal, timeoutMs?: number): Promise<DebtDay[]> {
  const debt = parseDebtToPenny(await readDebt(signal, timeoutMs));
  const published = debt.filter(({ heldByPublic, intragovernmental, total }) => heldByPublic !== null || intragovernmental !== null || total !== null);
  if (!published.length) throw sourceDidNotAnswer("No published debt figures received");
  return published;
}

export async function fetchTreasuryHistory(signal: AbortSignal, timeoutMs?: number): Promise<TgaClose[]> {
  const history = await readTga(signal, timeoutMs);
  if (!history.length) throw sourceDidNotAnswer("No closing balance history received");
  return history;
}

/**
 * The latest day's cash lines and the last 20 days of debt, with the account's
 * closing balance history unless `history` is off (a report that does not draw it).
 * A history that cannot be read leaves the figures as they are.
 */
export async function fetchTreasuryDaily(
  signal?: AbortSignal,
  { history = true, timeoutMs = FETCH_TIMEOUT_MS }: { history?: boolean; timeoutMs?: number } = {},
): Promise<TreasuryDaily> {
  const [cash, debt, tga] = await Promise.all([
    readCash(signal, timeoutMs),
    readDebt(signal, timeoutMs),
    history ? readTga(signal, timeoutMs).then(
      (closes) => ({ closes }),
      (error: unknown) => ({ closes: [] as TgaClose[], error: error instanceof Error ? error.message : String(error) }),
    ) : { closes: [] as TgaClose[] },
  ]).catch((error: unknown) => {
    if (error === signal?.reason && signal?.aborted) throw error;
    if (error instanceof ApiRequestError || error instanceof OperationTimeoutError) throw new Error(error.message);
    throw error;
  });
  signal?.throwIfAborted();
  return {
    cash: parseOperatingCash(cash),
    debt: parseDebtToPenny(debt),
    tga: tga.closes,
    ...("error" in tga ? { tgaError: tga.error } : {}),
  };
}
