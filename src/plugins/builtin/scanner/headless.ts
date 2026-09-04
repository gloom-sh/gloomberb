import type { ScannerFeedEvent, ScannerHiloPayload } from "../../../api-client";
import type {
  HeadlessPaneApiClient,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessSnapshotResult,
} from "../../../types/plugin";
import { buildHiloBarRows, filterHiloRows, type HiloMinPrice, type HiloSort } from "./hilo-model";

export function loadHiloSnapshot(
  client: Pick<HeadlessPaneApiClient, "subscribeScanner">,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<ScannerHiloPayload> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
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
      : new Error("Highs and lows snapshot aborted")));
    const timer = setTimeout(() => finish(() => reject(new Error("Highs and lows snapshot timed out"))), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = client.subscribeScanner("hilo", (event: ScannerFeedEvent) => {
      if (event.type === "denied") {
        finish(() => reject(new Error(event.reason === "pro_required" ? "Pro access required" : "Sign in required")));
        return;
      }
      if (event.payload.status === "starting") return;
      finish(() => resolve(event.payload as ScannerHiloPayload));
    });
    if (settled) unsubscribe();
  });
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
