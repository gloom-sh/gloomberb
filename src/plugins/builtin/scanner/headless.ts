import type {
  ScannerFeedEvent,
  ScannerFlowPayload,
  ScannerHiloPayload,
  ScannerPayload,
} from "../../../api-client";
import type {
  HeadlessPaneApiClient,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessPaneOptionDef,
  HeadlessSnapshotResult,
} from "../../../types/plugin";
import {
  DEFAULT_FLOW_FILTERS,
  FLOW_FILTER_OPTIONS,
  filterFlowEvents,
  type FlowFilters,
} from "./flow-model";
import { buildHiloBarRows, filterHiloRows, type HiloMinPrice, type HiloSort } from "./hilo-model";

type ScannerName = "hilo" | "flow";

// An idle scanner has to win the lock and seed its universe before it reports,
// which takes several seconds; a short wait turned every cold call into a
// timeout or a stale "degraded" row.
const SCANNER_SNAPSHOT_TIMEOUT_MS = 30_000;

const SCANNER_LABELS: Record<ScannerName, string> = {
  hilo: "Highs and lows",
  flow: "Options flow",
};

/**
 * Resolves on the first live or closed payload. A degraded payload is kept
 * and returned only if nothing better arrives before the deadline, since a
 * scanner warming up can pass through a stale row on its way to live.
 */
export function loadScannerSnapshot<T extends ScannerPayload>(
  client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
  scanner: ScannerName,
  signal: AbortSignal,
  timeoutMs = SCANNER_SNAPSHOT_TIMEOUT_MS,
): Promise<T> {
  const label = SCANNER_LABELS[scanner];
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let degraded: T | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error(`${label} snapshot aborted`)));
    const timer = setTimeout(() => finish(() => {
      if (degraded) resolve(degraded);
      else reject(new Error(`${label} snapshot timed out`));
    }), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = client.subscribeScanner(scanner, (event: ScannerFeedEvent) => {
      if (event.type === "denied") {
        finish(() => reject(new Error(event.reason === "pro_required" ? "Pro access required" : "Sign in required")));
        return;
      }
      const payload = event.payload as T;
      if (payload.status === "starting") return;
      if (payload.status === "degraded") {
        degraded = payload;
        return;
      }
      finish(() => resolve(payload));
    });
    if (settled) unsubscribe();
  });
}

export function loadHiloSnapshot(
  client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
  signal: AbortSignal,
  timeoutMs = SCANNER_SNAPSHOT_TIMEOUT_MS,
): Promise<ScannerHiloPayload> {
  return loadScannerSnapshot<ScannerHiloPayload>(client, "hilo", signal, timeoutMs);
}

export function projectHiloSnapshot(
  payload: ScannerHiloPayload,
  minPrice: HiloMinPrice,
  sort: HiloSort,
): HeadlessSnapshotResult {
  const lows = filterHiloRows(payload.lows, minPrice, sort).map((row) => ({ side: "low", ...row }));
  const highs = filterHiloRows(payload.highs, minPrice, sort).map((row) => ({ side: "high", ...row }));
  return {
    asOf: new Date(payload.asOf).toISOString(),
    items: [...lows, ...highs],
    ...(payload.status === "degraded" ? { errors: ["Scanner feed degraded"] } : {}),
    metadata: {
      status: payload.status,
      access: payload.access,
      delayMinutes: payload.delayMinutes,
      windows: buildHiloBarRows(payload.windows),
      minPrice,
      sort,
    },
  };
}

export interface HiloHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
    signal: AbortSignal,
  ): Promise<ScannerHiloPayload>;
}

const defaultDependencies: HiloHeadlessDependencies = {
  load: (_args, client, signal) => loadHiloSnapshot(client, signal),
};

export function createHiloHeadless(
  dependencies: HiloHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"snapshot"> {
  return {
    shape: "snapshot",
    argument: { kind: "none" },
    options: [
      {
        key: "minPrice",
        aliases: ["min-price"],
        settingKey: "minPrice",
        description: "Minimum stock price.",
        type: "enum",
        values: [{ value: "off" }, { value: "1" }, { value: "5" }],
        defaultValue: "1",
      },
      {
        key: "sort",
        settingKey: "sort",
        description: "Extreme ordering.",
        type: "enum",
        values: [{ value: "recent" }, { value: "count" }],
        defaultValue: "recent",
      },
    ],
    columns: [
      { key: "side", header: "Side" },
      { key: "symbol", header: "Symbol" },
      { key: "price", header: "Price", align: "right" },
      { key: "count", header: "Count", align: "right" },
      {
        key: "at",
        header: "Observed at",
        format: (value: unknown) => new Date(Number(value)).toISOString(),
      },
    ],
    describe: "New Highs / Lows",
    async load(args, ctx) {
      const payload = await dependencies.load(args, ctx.apiClient, ctx.signal);
      return projectHiloSnapshot(
        payload,
        args.options.minPrice as HiloMinPrice,
        args.options.sort as HiloSort,
      );
    },
  };
}

export const hiloHeadless = createHiloHeadless();

/** The pane's own filters, minus the watchlist universe that needs local lists. */
type FlowHeadlessFilterKey = Exclude<keyof FlowFilters, "universe">;

const FLOW_OPTION_DESCRIPTIONS: Record<FlowHeadlessFilterKey, string> = {
  minPremium: "Minimum print premium in dollars.",
  side: "Contract side.",
  kind: "Print kind.",
  volOi: "Day volume to open interest floor.",
  expiry: "Expiry window in days.",
};

const FLOW_OPTION_ALIASES: Partial<Record<FlowHeadlessFilterKey, string[]>> = {
  minPremium: ["min-premium"],
  volOi: ["vol-oi"],
};

function flowOption(key: FlowHeadlessFilterKey): HeadlessPaneOptionDef {
  return {
    key,
    ...(FLOW_OPTION_ALIASES[key] ? { aliases: FLOW_OPTION_ALIASES[key] } : {}),
    settingKey: key,
    description: FLOW_OPTION_DESCRIPTIONS[key],
    type: "enum",
    values: FLOW_FILTER_OPTIONS[key].map(({ value }) => ({ value })),
    defaultValue: DEFAULT_FLOW_FILTERS[key],
  };
}

export function projectFlowSnapshot(
  payload: ScannerFlowPayload,
  filters: FlowFilters,
  now = Date.now(),
): HeadlessSnapshotResult {
  const events = filterFlowEvents(payload.events, filters, new Set(), now);
  return {
    asOf: new Date(payload.asOf).toISOString(),
    items: events.map((event) => ({ ...event })),
    ...(payload.status === "degraded" ? { errors: ["Scanner feed degraded"] } : {}),
    metadata: {
      status: payload.status,
      access: payload.access,
      delayMinutes: payload.delayMinutes,
      received: payload.events?.length ?? 0,
      filters,
    },
  };
}

export interface FlowHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
    signal: AbortSignal,
  ): Promise<ScannerFlowPayload>;
}

export function createFlowHeadless(
  dependencies: FlowHeadlessDependencies = {
    load: (_args, client, signal) => loadScannerSnapshot<ScannerFlowPayload>(client, "flow", signal),
  },
): HeadlessPaneDefinition<"snapshot"> {
  const keys: FlowHeadlessFilterKey[] = ["minPremium", "side", "kind", "volOi", "expiry"];
  return {
    shape: "snapshot",
    argument: { kind: "none" },
    options: keys.map(flowOption),
    columns: [
      {
        key: "at",
        header: "Time",
        format: (value: unknown) => new Date(Number(value)).toISOString(),
      },
      { key: "underlying", header: "Ticker" },
      { key: "right", header: "Right" },
      { key: "kind", header: "Kind" },
      { key: "strike", header: "Strike", align: "right" },
      { key: "expiry", header: "Expiry" },
      { key: "side", header: "Side" },
      { key: "size", header: "Size", align: "right" },
      { key: "premium", header: "Premium", align: "right" },
      { key: "volOi", header: "Vol/OI", align: "right" },
    ],
    describe: "Options Flow",
    async load(args, ctx) {
      const payload = await dependencies.load(args, ctx.apiClient, ctx.signal);
      return projectFlowSnapshot(payload, {
        ...DEFAULT_FLOW_FILTERS,
        ...(args.options as Partial<FlowFilters>),
        universe: "active",
      });
    },
  };
}

export const flowHeadless = createFlowHeadless();
