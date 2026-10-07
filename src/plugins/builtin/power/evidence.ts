import type { PowerBoard, PowerHistory } from "../../../api-client/power";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchPowerBoard, fetchAllPowerHistory, validatePowerBoard, validatePowerHistory } from "./client";
import { otherRows, powerTab, projectRows } from "./model";
import { powerQuery } from "./query";
interface PowerEvidence {
  kind: "power";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  board: PowerBoard;
  history: PowerHistory | null;
  tab: string;
  rowIds: string[];
}
export function usePowerEvidence(board: PowerBoard | undefined, history: PowerHistory | undefined, tab: string, rowIds: string[], loading: boolean) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered power and grid observations", getMetadata: () => ({
    kind: "power", version: 1, complete: !!board && !loading, ready: !!board && !loading,
    plottedValueCount: rowIds.length, board, history: history ?? null, tab, rowIds,
  }) });
}
export const powerScreenshotEvidence: PaneScreenshotEvidenceHook<PowerEvidence> = {
  paneId: "power", kind: "power", label: "power and grid",
  async prepare({ resolved, settings }) {
    const tab = powerTab(settings.tab ?? resolved.options.tab);
    const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
    const filter = powerQuery({ ...settings, ...resolved.options, tab }, symbol);
    const board = await fetchPowerBoard({ ...filter, limit: 100 });
    const history = tab === "history" ? await fetchAllPowerHistory(filter) : undefined;
    return { settings: { powerSnapshot: { board, ...(history ? { history } : {}) } }, financials: [] };
  },
  read(value) {
    if (!isRecord(value) || value.kind !== "power" || value.version !== 1 || value.complete !== true || !isRecord(value.board)
      || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.plottedValueCount !== value.rowIds.length) return null;
    try {
      const board = validatePowerBoard(value.board as unknown as PowerBoard);
      const history = value.history ? validatePowerHistory(value.history as PowerHistory) : null;
      const tab = powerTab(value.tab);
      const rows = ["queue", "loads", "capacity"].includes(tab) ? projectRows(board.projects) : otherRows(tab, board, history?.points ?? []);
      if (value.rowIds.some((id) => !rows.some((r) => r.id === id))) return null;
      return value as unknown as PowerEvidence;
    } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const snapshot = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings?.powerSnapshot;
    const errors: string[] = [];
    if (!isRecord(snapshot) || JSON.stringify(snapshot.board) !== JSON.stringify(evidence.board)
      || JSON.stringify(snapshot.history ?? null) !== JSON.stringify(evidence.history)) errors.push("Power observations differ from the captured data.");
    if (evidence.tab !== powerTab(resolved.options.tab)) errors.push("Power tab does not match the requested view.");
    return errors;
  },
  unavailable(evidence) { return evidence?.complete ? [] : ["power observations"]; },
  symbols() { return []; },
};
