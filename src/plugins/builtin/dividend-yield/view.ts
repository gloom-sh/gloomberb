import type { DividendPayment } from "./types";

export interface DividendRow {
  key: string;
  exDate: string;
  amount: number;
  currency: string;
}

export function toDividendRows(payments: DividendPayment[]): DividendRow[] {
  return payments.map((payment, index) => ({
    key: `${payment.exDate.toISOString()}:${index}`,
    exDate: payment.exDate.toISOString().slice(0, 10),
    amount: payment.amount,
    currency: payment.currency,
  }));
}
