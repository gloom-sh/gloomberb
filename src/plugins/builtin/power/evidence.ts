import type { EuropePowerBoard, EuropePowerHistory } from "../../../api-client/europe-energy";
import type { PowerBoard, PowerHistory } from "../../../api-client/power";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchPowerBoard, fetchAllPowerHistory, fetchPowerTickerScopes, validatePowerBoard, validatePowerHistory } from "./client";
import { otherRows, powerTab, projectRows } from "./model";
import { fetchPowerPriceHistory, fetchPowerPrices, validatePowerPrices } from "./prices-client";
import { DEFAULT_PRICE_MARKET, powerPriceMarket } from "./prices-model";
import { powerQuery } from "./query";
interface PowerEvidence {
  kind: "power";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  /** The grid board, on every tab but Prices. */
  board: PowerBoard | null;
  history: PowerHistory | null;
  /** The day-ahead board, on the Prices tab. */
  prices?: EuropePowerBoard | null;
  tab: string;
  rowIds: string[];
}
/** What the Prices tab draws, frozen by `shot` so the capture and its check read the same days. */
export interface PowerPricesSnapshot {
  board: EuropePowerBoard;
  history: EuropePowerHistory | null;
}
export function usePowerEvidence(board: PowerBoard | undefined, history: PowerHistory | undefined, tab: string, rowIds: string[], loading: boolean) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered power and grid observations", getMetadata: () => ({
    kind: "power", version: 1, complete: !!board && !loading, ready: !!board && !loading,
    plottedValueCount: rowIds.length, board, history: history ?? null, tab, rowIds,
  }) });
}
export function usePowerPricesEvidence(prices: EuropePowerBoard | null, rowIds: string[], loading: boolean) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered day-ahead power prices", getMetadata: () => ({
    kind: "power", version: 1, complete: !!prices && !loading, ready: !!prices && !loading,
    plottedValueCount: rowIds.length, board: null, history: null, prices, tab: "prices", rowIds,
  }) });
}
const instanceSettings = (payload: Parameters<PaneScreenshotEvidenceHook["mismatches"]>[1]["payload"]) =>
  payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings;
export const powerScreenshotEvidence: PaneScreenshotEvidenceHook<PowerEvidence> = {
  paneId: "power", kind: "power", label: "power and grid",
  async prepare({ resolved, settings }) {
    const tab = powerTab(settings.tab ?? resolved.options.tab);
    if (tab === "prices") {
      const board = await fetchPowerPrices();
      const market = powerPriceMarket(resolved.createOptions?.arg)?.code ?? DEFAULT_PRICE_MARKET;
      const history = board.rows.some((row) => row.code === market && row.date) ? await fetchPowerPriceHistory(market) : null;
      return { settings: { powerPricesSnapshot: { board, history } satisfies PowerPricesSnapshot }, financials: [] };
    }
    const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
    const filter = powerQuery({ ...settings, ...resolved.options, tab }, symbol);
    const board = await fetchPowerBoard({ ...filter, limit: 100 });
    const history = tab === "history" ? await fetchAllPowerHistory(filter) : undefined;
    // A ticker with nothing on this tab: the counts that say where its records are, captured with the rest.
    const empty = !!symbol && tab !== "coverage" && !(tab === "history" ? history?.points.length : tab === "outcomes" ? board.rates.length
      : tab === "utilities" ? board.exposure.length : board.projects.length);
    const tickerScopes = empty && symbol ? await fetchPowerTickerScopes(symbol, tab, String(settings.context ?? resolved.options.context ?? "capacity")) : undefined;
    return { settings: { powerSnapshot: { board, ...(history ? { history } : {}), ...(tickerScopes ? { tickerScopes } : {}) } }, financials: [] };
  },
  read(value) {
    if (!isRecord(value) || value.kind !== "power" || value.version !== 1 || value.complete !== true
      || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.plottedValueCount !== value.rowIds.length) return null;
    try {
      const tab = powerTab(value.tab);
      if (tab === "prices") {
        if (!isRecord(value.prices)) return null;
        const prices = validatePowerPrices(value.prices as unknown as EuropePowerBoard);
        if (value.rowIds.some((id) => !prices.rows.some((row) => row.code === id))) return null;
        return value as unknown as PowerEvidence;
      }
      if (!isRecord(value.board)) return null;
      const board = validatePowerBoard(value.board as unknown as PowerBoard);
      const history = value.history ? validatePowerHistory(value.history as PowerHistory) : null;
      const rows = ["queue", "loads", "capacity"].includes(tab) ? projectRows(board.projects) : otherRows(tab, board, history?.points ?? []);
      if (value.rowIds.some((id) => !rows.some((r) => r.id === id))) return null;
      return value as unknown as PowerEvidence;
    } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const settings = instanceSettings(payload);
    const errors: string[] = [];
    if (evidence.tab === "prices") {
      const snapshot = settings?.powerPricesSnapshot;
      if (!isRecord(snapshot) || JSON.stringify(snapshot.board) !== JSON.stringify(evidence.prices)) errors.push("Power prices differ from the captured data.");
    } else {
      const snapshot = settings?.powerSnapshot;
      if (!isRecord(snapshot) || JSON.stringify(snapshot.board) !== JSON.stringify(evidence.board)
        || JSON.stringify(snapshot.history ?? null) !== JSON.stringify(evidence.history)) errors.push("Power observations differ from the captured data.");
    }
    // EPWR opens the Prices tab by its settings; POWER by --tab.
    if (evidence.tab !== powerTab(resolved.options.tab ?? settings?.tab)) errors.push("Power tab does not match the requested view.");
    return errors;
  },
  unavailable(evidence) { return evidence?.complete ? [] : [evidence?.tab === "prices" ? "power prices" : "power observations"]; },
  symbols() { return []; },
};
