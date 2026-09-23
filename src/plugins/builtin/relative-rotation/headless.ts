import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchRotation } from "./client";
import { rotationInstruments, sectorRotationInstruments } from "./model";

/** Same rounding as the pane: ratios to 2 decimals, percentiles whole. */
const fixed = (value: unknown, digits: number) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";

export const rotationHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "symbol-list",
    optional: true,
    maximum: 24,
    description: "Symbols or SYMBOL:EXCHANGE; defaults to US sectors.",
  },
  options: [
    {
      key: "benchmark",
      type: "string",
      description: "Benchmark listing.",
      defaultValue: "SPY:NYSEARCA",
    },
    {
      key: "trail",
      type: "integer",
      description: "Completed weeks in each trail.",
      defaultValue: 6,
      minimum: 2,
      maximum: 12,
    },
  ],
  describe: "Relative rotation",
  discovery: {
    aliases: ["RRG", "GRR"],
    dataRequirements: ["Cloud daily history and listing currencies"],
    limitations: [
      "Transparent 13-week strength and 4-week momentum, not proprietary JdK indices",
      "Same-currency price returns; dividends are not reinvested",
      "Completed weeks only",
    ],
  },
  async load(args, ctx) {
    const references = rotationInstruments(
      String(args.options.benchmark ?? "SPY:NYSEARCA"),
    );
    if (references.length !== 1) throw new Error("Choose one benchmark.");
    const instruments = args.symbols.length
      ? rotationInstruments(args.symbols.join(","))
      : sectorRotationInstruments();
    const data = await fetchRotation(
      references[0]!,
      instruments,
      Number(args.options.trail ?? 6),
      ctx.apiClient,
    );
    const errors = [
      ...data.gaps,
      ...data.rows.flatMap((row) =>
        row.gaps.map((gap) => `${row.symbol}: ${gap}`),
      ),
    ];
    return {
      complete: errors.length === 0,
      symbols: instruments.map((row) => row.symbol),
      unavailableSymbols: data.rows
        .filter((row) => row.strength == null)
        .map((row) => row.symbol),
      errors,
      sections: [
        {
          title: `Versus ${data.benchmark.symbol}`,
          columns: [
            { key: "symbol", header: "Symbol" },
            { key: "label", header: "Name" },
            { key: "quadrant", header: "Quadrant" },
            { key: "strength", header: "Strength", align: "right", format: (value) => fixed(value, 2) },
            { key: "strengthPercentile", header: "Pctl 1Y", align: "right", format: (value) => fixed(value, 0) },
            { key: "momentum", header: "Momentum", align: "right", format: (value) => fixed(value, 2) },
            { key: "momentumPercentile", header: "Pctl 1Y", align: "right", format: (value) => fixed(value, 0) },
            { key: "asOf", header: "As of" },
          ],
          rows: data.rows.map((row) => ({
            ...row,
            strengthPercentile: row.strengthRank.percentile,
            momentumPercentile: row.momentumRank.percentile,
          })),
        },
      ],
      metadata: { ...data },
    };
  },
};
