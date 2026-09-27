import { expect, test } from "bun:test";
import { colors } from "../../../theme/colors";
import { analyticsFigures, riskFigureNotices, type AnalyticsMetricRow } from "./view";

const summary: AnalyticsMetricRow[] = [
  { id: "cash", label: "Cash", value: "6.9k", color: colors.text },
  { id: "net-liquidation", label: "Net Liq", value: "81.5k", color: colors.text },
  { id: "account-source", label: "Source", value: "Flex Sep 25", color: colors.textDim },
  { id: "pnl", label: "P&L", value: "+26.8k", detail: "(+85.02%)" },
  { id: "day-pnl", label: "Day", value: "0.00", detail: "(—)" },
];
const risk: AnalyticsMetricRow[] = [
  { id: "sharpe", label: "Est. Sharpe", value: "—", detail: "Incomplete holding history", color: colors.textMuted },
  { id: "beta", label: "Est. Beta (SPY)", value: "—", detail: "Incomplete holding history", color: colors.textMuted },
];

test("overview figures lead with the account level and keep their details short", () => {
  const figures = analyticsFigures(summary, risk);
  expect(figures.map((figure) => figure.id)).toEqual(["net-liquidation", "day-pnl", "pnl", "cash", "sharpe", "beta", "account-source"]);
  expect(figures.find((figure) => figure.id === "pnl")?.detail).toBe("+85.02%");
  expect(figures.find((figure) => figure.id === "day-pnl")?.detail).toBeUndefined();
  // The reason a basket estimate is missing goes to the footer, once.
  expect(figures.find((figure) => figure.id === "sharpe")?.detail).toBeUndefined();
  expect(riskFigureNotices(risk)).toEqual(["Est. Sharpe, Est. Beta (SPY): Incomplete holding history"]);
  // Plain text takes the grid's own colour; muted and domain colours stay.
  expect(figures.find((figure) => figure.id === "cash")?.color).toBeUndefined();
  expect(figures.find((figure) => figure.id === "sharpe")?.color).toBe(colors.textMuted);
});
