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
