import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import { rowsFreshness } from "../../../cli/freshness";
import { humanizeCliKey } from "../../../cli/result";
import type { CliCommandDef } from "../../../types/plugin";
import { loadFearGreed } from "./cache";

const SCORE_KEYS = new Set(["score", "previousClose", "previousWeek", "previousMonth", "previousYear"]);
/** A score to a tenth of a point (17.9); a missing one leaves its cell empty, as before. */
const scoreTenths = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "";

// Without the pane cache attached, this fetches a fresh reading for the command.
export const fearGreedCliCommand: CliCommandDef = {
  name: "fear-greed",
  description: "Fetch CNN Fear & Greed gauge data",
  help: { group: CLI_COMMAND_GROUPS.markets },
  async execute(_args, ctx) {
    const { data, stale } = await loadFearGreed(ctx.cliOptions.refresh);
    const rows = [{
      score: data.overall.score,
      rating: data.overall.rating,
      updatedAt: data.overall.updatedAt?.toISOString() ?? "",
      previousClose: data.overall.previousClose,
      previousWeek: data.overall.previousWeek,
      previousMonth: data.overall.previousMonth,
      previousYear: data.overall.previousYear,
    }];
    ctx.printResult({
      data: rows,
      // Exports cite CNN's reading as `fn FNG` does; the text stays the row alone.
      exportFreshness: rowsFreshness(rows, { source: "CNN", status: stale ? "stale" : "not-a-feed", basis: "published index" }),
      metadata: {
        indicators: data.indicators.map((indicator) => ({
          id: indicator.definition.id,
          score: indicator.score,
          rating: indicator.rating,
        })),
      },
    }, {
      // Scores read to a tenth of a point on the text table; exports keep every digit.
      textColumns: Object.keys(rows[0]!).map((key) => ({ key, header: humanizeCliKey(key),
        ...(SCORE_KEYS.has(key) ? { align: "right" as const, format: scoreTenths } : {}) })),
    });
  },
};
