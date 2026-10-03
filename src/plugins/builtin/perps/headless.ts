import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPerpsBoard, fetchPerpsMarket, fetchPerpsCompare, fetchPerpsHistory, fetchPerpsRankings, RANKING_KEYS } from "./client";
import { ASSET_FILTERS, boardRows, PERP_TABS } from "./model";

export const perpsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "market", description: "Underlying or canonical market identity, such as BTC or hyperliquid:xyz:TSLA." },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", values: PERP_TABS.map((value) => ({ value })), defaultValue: "board", description: "Board, history, rankings, comparison or evidence." },
    { key: "asset", type: "enum", settingKey: "asset", values: ASSET_FILTERS.map((value) => ({ value })), defaultValue: "all", description: "Asset class." },
    { key: "days", type: "enum", values: ["1", "7", "30", "90", "365"].map((value) => ({ value })), defaultValue: "7", description: "History lookback in days." },
  ],
  discovery: { aliases: ["PERP"], dataRequirements: ["Perpetual market observations"], limitations: ["Pro dataset with a fixed free preview", "Rates, premiums and changes are fractions in JSON", "Open-interest history begins at first collection", "Funding APR is a simple annualization, not a forecast", "Analytics only; trading is a separate plugin"] },
  describe: "Perpetual markets (Pro)",
  async load(args, ctx) {
    const search = String(Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "");
    const board = await fetchPerpsBoard(ctx.apiClient);
    const rows = boardRows(board.rows, String(args.options.asset ?? "all"), search, { column: "openInterestUsd", direction: "desc" });
    const tab = args.options.tab ?? "board";
    let payload: object = board;
    let sections: { title: string; rows: Record<string, unknown>[] }[] = [{ title: "Markets", rows: rows.map((row) => ({ ...row })) }];
    if (tab === "rankings") {
      const rankings = await fetchPerpsRankings(ctx.apiClient); payload = rankings;
      sections = RANKING_KEYS.map((key) => ({ title: key.replace(/([A-Z])/g, " $1"), rows: boardRows(rankings[key], String(args.options.asset ?? "all"), search, { column: key === "oiSurges" ? "oiChange24h" : "fundingRate8h", direction: key === "fundingNegative" ? "asc" : "desc" }).map((row) => ({ ...row })) }));
    } else if (tab === "compare") {
      const comparison = await fetchPerpsCompare(rows[0]?.baseAsset ?? (search.toUpperCase() || "BTC"), ctx.apiClient); payload = comparison;
      sections = [{ title: "Contracts", rows: comparison.rows.map((row) => ({ ...row })) }];
    } else if (tab === "history") {
      if (!rows[0]) return { sections: [{ title: "History", rows: [] }], errors: ["No market matches the selection"], complete: false };
      const history = await fetchPerpsHistory({ marketId: rows[0].marketId, from: new Date(Date.now() - Number(args.options.days ?? 7) * 86_400_000).toISOString(), resolution: "auto", limit: 3000 }, ctx.apiClient); payload = history;
      sections = [{ title: "Own observations", rows: history.rows.map((row) => ({ ...row })) }, { title: "Paid funding", rows: history.funding.map((row) => ({ ...row })) }, { title: "Hourly candles", rows: history.candles.map((row) => ({ ...row })) }];
    } else if (tab === "evidence" && rows[0]) {
      const evidence = await fetchPerpsMarket(rows[0].marketId, ctx.apiClient); payload = evidence;
      sections = [{ title: "Market evidence", rows: evidence.rows.map((row) => ({ ...row })) }, { title: "Observation revisions", rows: evidence.evidence.map((row) => ({ ...row })) }];
    }
    const status = payload as { access: string; locked: number | boolean; asOf: string | null; status: string };
    return { sections, complete: !status.locked && status.status === "ok", errors: status.locked ? ["Full data requires Gloom Pro"] : [],
      metadata: { asOf: status.asOf, access: status.access, locked: status.locked, status: status.status, rates: "fraction", quoteCurrency: "per contract", oiCurrency: "USD", provenance: "sourceUrl and observation timestamps on every market" } };
  },
};
