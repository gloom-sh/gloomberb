import { MarketDataCoordinator } from "../../../market-data/coordinator";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessInstrument } from "../shared/headless-market-data";
import { loadPeBandInputs } from "./client";
import { formatPerShare, fxPairQuote, projectPeBand } from "./model";
import { DAILY_CLOSES } from "../shared/report-freshness";

const multiple = (value: unknown) => typeof value === "number" ? `${value.toFixed(1)}x` : "--";
const amount = (value: unknown) => typeof value === "number" ? formatPerShare(value) : "--";
const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "--";

export const peBandHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", description: "Ticker" },
  freshness: { ...DAILY_CLOSES, basis: "daily closes and reported EPS" },
  describe: (args) => `PEB ${args.symbols[0] ?? ""}`,
  discovery: { screenshotReadiness: "live-dom", limitations: [
    "Weekly closes. EPS reported in another currency than a dollar price is converted at daily FX closes; other currency pairs are not computed.",
  ] },
  options: [
    { key: "lookbackYears", type: "integer", minimum: 0, maximum: 30, defaultValue: 10, description: "Years of history; 0 for all on record" },
  ],
  async load(args, ctx) {
    const instrument = await resolveHeadlessInstrument(ctx, args.symbols[0]!);
    const inputs = await loadPeBandInputs({ instrument, signal: ctx.signal }, ctx.marketData, new MarketDataCoordinator(ctx.marketData), ctx.apiClient);
    ctx.signal.throwIfAborted();
    const lookbackYears = Number(args.options.lookbackYears ?? 10);
    const model = projectPeBand(inputs.financials, inputs.history, { symbol: instrument.symbol, lookbackYears, reports: inputs.reports,
      fx: inputs.fx, fxError: inputs.fxError });
    const current = model.current;
    const conversion = model.conversion;
    const pairQuote = (rate: number) => {
      const quote = fxPairQuote(conversion!.currency, rate);
      return `${quote.pair} ${quote.value.toPrecision(5)}`;
    };
    const reported = current?.step?.eps != null && conversion && current.step.currency === conversion.currency
      ? `, from ${conversion.currency} ${amount(current.step.eps)} at ${pairQuote(conversion.latest.rate)} (${conversion.latest.date} close)` : "";
    return {
      sections: [
        { title: "P/E band", columns: [{ key: "label", header: "" }, { key: "value", header: "Value" }], rows: [
          { label: "Trailing P/E", value: multiple(current?.pe) },
          { label: "Percentile of own history", value: current?.percentile == null ? "--" : `${current.percentile.toFixed(0)}` },
          { label: "Ranked over", value: model.sample ? `${model.sample.weeks} weeks since ${model.sample.start.toISOString().slice(0, 10)}` : "--" },
          { label: "P/E low, median, high", value: model.range ? `${multiple(model.range.min)}, ${multiple(model.range.median)}, ${multiple(model.range.max)}` : "--" },
          { label: "Price", value: `${amount(current?.price)} ${model.currency ?? ""}`.trim() },
          { label: "Trailing EPS", value: current?.step
            ? `${amount(current.eps)} (${current.step.basis === "annual" ? "FY" : "TTM"} ${current.step.periodEnd})${reported}` : "--" },
        ] },
        { title: "Price at each multiple", columns: [{ key: "multiple", header: "Multiple", format: multiple }, { key: "price", header: "Price", format: amount }],
          rows: model.multiples.map((value) => ({ multiple: value, price: current?.eps != null && current.eps > 0 ? value * current.eps : null })) },
        { title: "Trailing EPS", columns: [{ key: "periodEnd", header: "Period end" }, { key: "basis", header: "Basis" },
          { key: "knownAt", header: "Known" }, { key: "eps", header: conversion ? "EPS reported" : "EPS", format: amount },
          ...(conversion ? [{ key: "currency", header: "Currency" }, { key: "fx", header: "FX close" }] : []),
          { key: "yoy", header: "YoY", format: percent }, { key: "price", header: "Price", format: amount }, { key: "pe", header: "P/E", format: multiple }],
        rows: model.rows.map((row) => ({ periodEnd: row.periodEnd, basis: row.basis === "annual" ? "FY" : "TTM",
          knownAt: row.dated ? row.knownAt.toISOString().slice(0, 10) : "period end", eps: row.eps,
          ...(conversion ? { currency: row.currency, fx: row.fx ? `${pairQuote(row.fx.rate)} (${row.fx.date})` : row.currency === model.currency ? "" : "--" } : {}),
          yoy: row.yoy, price: row.price, pe: row.pe })) },
      ],
      complete: !inputs.stale && !inputs.error && !inputs.historyError && !model.error,
      unavailableSymbols: current?.pe != null ? [] : [instrument.symbol],
      errors: [inputs.error, inputs.historyError, model.error, model.notice].filter((value): value is string => !!value),
      metadata: { currency: model.currency, lookbackYears,
        epsConversion: conversion ? { from: conversion.currency, to: model.currency, usdPerUnit: conversion.latest.rate, latestClose: conversion.latest.date,
          basis: "daily FX close on or before each date: a week's bar date for the band, the publication date for each table row, the latest completed close for the current P/E" } : null,
        sampleStart: model.sample?.start.toISOString().slice(0, 10) ?? null, sampleWeeks: model.sample?.weeks ?? 0, multiples: model.multiples, undatedEpsPeriods: model.undated, unavailableTtmSums: model.unavailable,
        stale: inputs.stale, fetchedAt: inputs.fetchedAt, methodology: "docs/research-data.md#pe-band" },
    };
  },
};
