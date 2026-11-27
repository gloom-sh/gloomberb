import type { HttpFetchTransport } from "../../../utils/http-transport";
import type { DividendSummary } from "../../../api-client/market-discovery";

const number = (value: any): number | null => typeof value === "number" ? value : typeof value?.raw === "number" ? value.raw : null;

/** Builds neutral API summary fixtures from concise optional fields. */
export function summaryFields(result: any): DividendSummary {
  const detail = result?.summaryDetail;
  return {
    trailingAnnualDividendRate: number(detail?.trailingAnnualDividendRate),
    trailingAnnualDividendYield: number(detail?.trailingAnnualDividendYield),
    forwardAnnualDividendRate: number(detail?.forwardAnnualDividendRate) ?? number(detail?.dividendRate),
    payoutRatio: number(result?.financialData?.payoutRatio) ?? number(detail?.payoutRatio),
    exDividendDate: number(detail?.exDividendDate), dividendDate: number(detail?.dividendDate),
    currency: typeof detail?.currency === "string" ? detail.currency : null,
  };
}

/** Independent cash and summary fixture controls are combined into the backend response. */
export function marketTransport(route: (url: string) => Response | Promise<Response>): HttpFetchTransport {
  return async (url) => {
    const symbol = new URL(url).searchParams.get("symbol") ?? "FIXTURE";
    const [history, summary] = await Promise.allSettled([
      Promise.resolve().then(() => route(`https://fixture.invalid/chart/${encodeURIComponent(symbol)}`)).then(r => r.json()),
      Promise.resolve().then(() => route(`https://fixture.invalid/quoteSummary/${encodeURIComponent(symbol)}`)).then(r => r.json()),
    ]);
    const chart = history.status === "fulfilled" ? history.value?.chart?.result?.[0] : null;
    const summaryResult = summary.status === "fulfilled" ? summary.value?.quoteSummary?.result?.[0] : null;
    const dividends = Object.values(chart?.events?.dividends ?? {}).map((event: any) => {
      const date = new Date(event.date * 1000);
      const valid = Number.isFinite(date.getTime());
      const exDate = valid ? new Intl.DateTimeFormat("en-CA", { timeZone: chart?.meta.exchangeTimezoneName ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date) : "invalid";
      return { exDate, amount: event.amount };
    });
    return Response.json({ status: "success", data: {
      actions: chart ? { symbol, currency: chart.meta.currency, dividends, splits: [], earnings: [], providerId: "gloomberb-cloud", fetchedAt: new Date().toISOString(), coverage: { dividends: "available" } } : null,
      quote: chart ? { symbol, currency: chart.meta.currency, price: chart.meta.regularMarketPrice, lastUpdated: chart.meta.regularMarketTime * 1000, exchangeName: chart.meta.exchangeName, providerId: "gloomberb-cloud", dataSource: "delayed" } : null,
      summary: summaryResult ? summaryFields(summaryResult) : null,
    } });
  };
}

/** One source cash series and its independently timestamped reference quote. */
export function chartResponse({ meta, time, close = 100, dividends }: {
  meta: Record<string, unknown>;
  time: number;
  close?: number;
  dividends: Record<string, unknown>;
}): Response {
  return Response.json({ chart: { result: [{ meta, timestamp: [time], indicators: { quote: [{ close: [close] }] }, events: { dividends } }] } });
}

export function hsbcIssuerDividendRead(currency = "GBp", fixedCash?: number, source?: { publisher: string; url: string; scheduleUrl?: string }) {
  const divisor = currency === "GBp" ? 100 : 1;
  const cashEstimate = { declaredCurrency: "USD", declaredAmount: 0.1, fixingDate: "2026-12-07",
    basis: "Reported cash estimate; the issuer's GBP conversion is not fixed." };
  return {
    quote: { symbol: "HSBA", currency: "GBp", price: 1338, lastUpdated: Date.parse("2026-11-16T16:30:00Z"), dataSource: "delayed" },
    summary: { currency: "GBP", trailingAnnualDividendRate: 0.556718, trailingAnnualDividendYield: null, payoutRatio: null,
      forwardAnnualDividendRate: 0.30334, forwardRateAsOf: "2026-11-05", exDividendDate: Date.parse("2026-11-05") / 1000,
      dividendDate: Date.parse("2026-12-17") / 1000 },
    actions: { symbol: "HSBA", currency, coverage: { dividends: "available" }, splits: [], earnings: [],
      fetchedAt: "2026-11-17T06:00:00Z", dividends: [
        { exDate: "2026-08-13", amount: 0.074134 * divisor }, { exDate: "2026-05-14", amount: 0.074489 * divisor },
        { exDate: "2026-03-12", amount: 0.333016 * divisor }, { exDate: "2025-11-06", amount: 0.075079 * divisor },
        // A year earlier's final and interims, which tell this March's final from a one-off.
        { exDate: "2025-08-14", amount: 0.073562 * divisor }, { exDate: "2025-05-08", amount: 0.074512 * divisor },
        { exDate: "2025-03-06", amount: 0.278597 * divisor },
      ], declaredDividends: [{ exDate: "2026-11-05", payDate: "2026-12-17", amount: (fixedCash ?? 0.075835) * divisor,
        ...(fixedCash == null ? { cashEstimate } : {}), ...(source ? { source } : {}) }],
      declaredCash: { currency: "USD", rows: [{ exDate: "2026-11-05", amount: 0.1 }, { exDate: "2026-08-13", amount: 0.1 },
        { exDate: "2026-05-14", amount: 0.1 }, { exDate: "2026-03-12", amount: 0.45 }, { exDate: "2025-11-06", amount: 0.1 },
        { exDate: "2025-08-14", amount: 0.1 }, { exDate: "2025-05-08", amount: 0.1 }, { exDate: "2025-03-06", amount: 0.36 }],
        announced: { exDate: "2026-11-05", payDate: "2026-12-17", amount: 0.1, fixingDate: "2026-12-07",
          ...(fixedCash != null ? { paidAmount: fixedCash * divisor } : {}) } },
    },
  };
}
