import type { CarbonBoard, CarbonHistory, EuropePowerBoard, EuropePowerHistory, GasStorageBoard, GasStorageSeasonal } from "../../../api-client/europe-energy";
import type { PowerBoard, PowerHistory } from "../../../api-client/power";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchPowerBoard, fetchAllPowerHistory, fetchPowerTickerScopes, validatePowerBoard, validatePowerHistory } from "./client";
import { otherRows, powerTab, projectRows } from "./model";
import { fetchGasSeasonal, fetchGasStorage, validateGasStorage } from "./gas-client";
import { parseGasQuery } from "./gas-model";
import { fetchCarbonHistory, fetchCarbonPrice, fetchPowerPriceHistory, fetchPowerPrices, validateCarbonPrice, validatePowerPrices } from "./prices-client";
import { DEFAULT_PRICE_MARKET, isCarbonQuery, powerPriceMarket } from "./prices-model";
import { powerQuery } from "./query";
interface PowerEvidence {
  kind: "power";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  /** The grid board, on every tab but Prices. */
  board: PowerBoard | null;
  history: PowerHistory | null;
  /** The day-ahead board and the EUA board, on the Prices tab. */
  prices?: EuropePowerBoard | null;
  carbon?: CarbonBoard | null;
  /** The gas storage board, on the Prices tab's gas board. */
  gas?: GasStorageBoard | null;
  tab: string;
  rowIds: string[];
}
/** What the Prices tab draws, frozen by `shot` so the capture and its check read the same days. */
export interface PowerPricesSnapshot {
  board: EuropePowerBoard;
  /** The charted history: the selected market's, or the carbon allowance's for EPWR EUA. */
  history: EuropePowerHistory | CarbonHistory | null;
  /** Null when the server has no EUA price yet; the tab then shows the board alone. */
  carbon: CarbonBoard | null;
}
/** What the gas board draws, frozen by `shot`: the board and the selected area's seasonal range. */
export interface GasStorageSnapshot {
  board: GasStorageBoard;
  seasonal: GasStorageSeasonal | null;
}
export function usePowerEvidence(board: PowerBoard | undefined, history: PowerHistory | undefined, tab: string, rowIds: string[], loading: boolean) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered power and grid observations", getMetadata: () => ({
    kind: "power", version: 1, complete: !!board && !loading, ready: !!board && !loading,
    plottedValueCount: rowIds.length, board, history: history ?? null, tab, rowIds,
  }) });
}
export function usePowerPricesEvidence(prices: EuropePowerBoard | null, carbon: CarbonBoard | null, rowIds: string[], loading: boolean) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered day-ahead power and carbon prices", getMetadata: () => ({
    kind: "power", version: 1, complete: !!prices && !loading, ready: !!prices && !loading,
    plottedValueCount: rowIds.length, board: null, history: null, prices, carbon, tab: "prices", rowIds,
  }) });
}
export function useGasStorageEvidence(gas: GasStorageBoard | null, rowIds: string[], loading: boolean) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered European gas storage", getMetadata: () => ({
    kind: "power", version: 1, complete: !!gas && !loading, ready: !!gas && !loading,
    plottedValueCount: rowIds.length, board: null, history: null, gas, tab: "prices", rowIds,
  }) });
}
const instanceSettings = (payload: Parameters<PaneScreenshotEvidenceHook["mismatches"]>[1]["payload"]) =>
  payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings;
export const powerScreenshotEvidence: PaneScreenshotEvidenceHook<PowerEvidence> = {
  paneId: "power", kind: "power", label: "power and grid",
  async prepare({ resolved, settings }) {
    const tab = powerTab(settings.tab ?? resolved.options.tab);
    if (tab === "prices" && parseGasQuery(resolved.createOptions?.arg)) {
      const gas = await fetchGasStorage();
      const area = parseGasQuery(resolved.createOptions?.arg)!.area.code;
      const seasonal = gas.rows.some((row) => row.code === area && row.gasDay) ? await fetchGasSeasonal(area) : null;
      return { settings: { gasStorageSnapshot: { board: gas, seasonal } satisfies GasStorageSnapshot }, financials: [] };
    }
    if (tab === "prices") {
      const board = await fetchPowerPrices();
      // The carbon figures are captured when the server has them, and left out when it does not.
      const carbon = await fetchCarbonPrice().catch(() => null);
      const arg = resolved.createOptions?.arg;
      const market = powerPriceMarket(arg)?.code ?? DEFAULT_PRICE_MARKET;
      const history = isCarbonQuery(arg) && carbon?.row.date ? await fetchCarbonHistory()
        : board.rows.some((row) => row.code === market && row.date) ? await fetchPowerPriceHistory(market) : null;
      return { settings: { powerPricesSnapshot: { board, history, carbon } satisfies PowerPricesSnapshot }, financials: [] };
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
      if (tab === "prices" && isRecord(value.gas)) {
        const gas = validateGasStorage(value.gas as unknown as GasStorageBoard);
        if (value.rowIds.some((id) => !gas.rows.some((row) => row.code === id))) return null;
        return value as unknown as PowerEvidence;
      }
      if (tab === "prices") {
        if (!isRecord(value.prices)) return null;
        const prices = validatePowerPrices(value.prices as unknown as EuropePowerBoard);
        if (value.carbon != null) validateCarbonPrice(value.carbon as unknown as CarbonBoard);
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
    if (evidence.tab === "prices" && evidence.gas) {
      const snapshot = settings?.gasStorageSnapshot;
      if (!isRecord(snapshot) || JSON.stringify(snapshot.board) !== JSON.stringify(evidence.gas)) errors.push("Gas storage differs from the captured data.");
    } else if (evidence.tab === "prices") {
      const snapshot = settings?.powerPricesSnapshot;
      if (!isRecord(snapshot) || JSON.stringify(snapshot.board) !== JSON.stringify(evidence.prices)
        || JSON.stringify(snapshot.carbon ?? null) !== JSON.stringify(evidence.carbon ?? null)) errors.push("Power prices differ from the captured data.");
    } else {
      const snapshot = settings?.powerSnapshot;
      if (!isRecord(snapshot) || JSON.stringify(snapshot.board) !== JSON.stringify(evidence.board)
        || JSON.stringify(snapshot.history ?? null) !== JSON.stringify(evidence.history)) errors.push("Power observations differ from the captured data.");
    }
    // EPWR opens the Prices tab by its settings; POWER by --tab.
    if (evidence.tab !== powerTab(resolved.options.tab ?? settings?.tab)) errors.push("Power tab does not match the requested view.");
    return errors;
  },
  unavailable(evidence) { return evidence?.complete ? [] : [evidence?.gas ? "gas storage" : evidence?.tab === "prices" ? "power prices" : "power observations"]; },
  symbols() { return []; },
};
