import type { MarketContext } from "../../../../cli/types";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import {
  loadResolvedHeadlessPaneModel,
  serializeHeadlessPaneResult,
  type LoadedHeadlessPaneModel,
} from "../../../../cli/pane-functions/headless";
import { resolvePaneFunction } from "../../../../cli/pane-functions/resolver";
import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneResult,
  HeadlessSeriesResult,
  HeadlessSnapshotResult,
} from "../../../../types/headless";
import {
  MAX_TOOL_RESULT_BYTES,
  type ASKGToolCallEvent,
  type ClientToolManifest,
  type JsonValue,
  type ToolResultPayload,
  type ToolResultStatus,
} from "./protocol";
import { normalizeJson } from "./json";
import {
  capToolNote,
  joinToolNotes,
  summarizeToolWarnings,
  toolErrorNote,
} from "./notes";
import { describeTrimmedLists, fitResultToBytes } from "./result-budget";
import {
  remoteRequestForTool,
  resolveRemoteToolBinding,
} from "./manifest";
import {
  ASKGUndoManager,
  type AppliedUndo,
  type InProcessRemoteControlHandler,
} from "./undo";

interface HeadlessExecution {
  result: unknown;
  rowCount: number;
  errors?: string[];
}

interface HeadlessToolCall {
  name: string;
  args: Record<string, JsonValue>;
  manifest: ClientToolManifest;
  signal: AbortSignal;
}

type HeadlessToolExecutor = (call: HeadlessToolCall) => Promise<HeadlessExecution>;

export interface ASKGToolExecutorDependencies {
  manifests: readonly ClientToolManifest[];
  registry: PaneFunctionCatalog;
  context: MarketContext;
  remoteHandler: InProcessRemoteControlHandler;
  headlessExecutor?: HeadlessToolExecutor;
  undoManager?: ASKGUndoManager;
  now?: () => number;
}

interface ASKGToolExecutionOptions {
  signal?: AbortSignal;
  confirmed?: boolean;
}

export interface ASKGToolExecutor {
  execute(
    call: ASKGToolCallEvent,
    options?: ASKGToolExecutionOptions,
  ): Promise<ToolResultPayload>;
  undo(token: string, signal?: AbortSignal): Promise<AppliedUndo>;
}

interface ExecutionValue {
  status: ToolResultStatus;
  result?: unknown;
  rowCount?: number;
  truncated?: boolean;
  note?: string;
  rev?: string;
  undoToken?: string;
}

const ARGUMENT_KEYS = new Set(["symbol", "symbols", "text"]);
/** The list of shortened values gets this much of the note; the rest is the tool's own. */
const TRIM_DESCRIPTION_LENGTH = 160;

class ToolTimeoutError extends Error {}
class ToolCancelledError extends Error {}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Room left for the note that says what was trimmed. */
const TRIM_NOTE_RESERVE_BYTES = 1_024;

/**
 * Keeps the posted payload under the server's byte cap. An oversized result
 * loses rows (one text value is cut only when no list can shrink), so what
 * reaches Gloom is still whole records and the note says what was shortened.
 */
function withBoundedPayload(payload: ToolResultPayload): ToolResultPayload {
  if (encodedSize(payload) <= MAX_TOOL_RESULT_BYTES) return payload;

  const status = payload.status === "ok" ? "partial" : payload.status;
  const overhead = encodedSize({ ...payload, result: null }) + TRIM_NOTE_RESERVE_BYTES;
  const fitted = payload.result === undefined
    ? null
    : fitResultToBytes(payload.result, MAX_TOOL_RESULT_BYTES - overhead);
  if (fitted) {
    const trimmed = describeTrimmedLists(fitted.trimmed);
    const bounded: ToolResultPayload = {
      ...payload,
      status,
      result: fitted.result,
      truncated: true,
      note: joinToolNotes(
        payload.note,
        `Trimmed to fit the size limit${trimmed ? `: ${capToolNote(trimmed, TRIM_DESCRIPTION_LENGTH)}` : ""}.`,
      ),
    };
    if (encodedSize(bounded) <= MAX_TOOL_RESULT_BYTES) return bounded;
  }

  const withoutResult: ToolResultPayload = {
    turnId: payload.turnId,
    toolCallId: payload.toolCallId,
    status,
    rowCount: payload.rowCount,
    truncated: true,
    elapsedMs: payload.elapsedMs,
    note: "Result exceeded the client payload limit and was omitted.",
    ...(payload.rev ? { rev: payload.rev } : {}),
    ...(payload.undoToken ? { undoToken: payload.undoToken } : {}),
  };
  return withoutResult;
}

function rawArgumentFor(manifest: ClientToolManifest, args: Record<string, JsonValue>): string {
  switch (manifest.argument?.kind) {
    case "none":
    case undefined:
      return "";
    case "ticker": {
      const symbol = args.symbol;
      if (symbol == null && manifest.argument.optional) return "";
      if (typeof symbol !== "string") throw new Error(`${manifest.name} requires a symbol string.`);
      return symbol;
    }
    case "tickers":
    case "symbol-list": {
      const symbols = args.symbols;
      if (symbols == null && manifest.argument.optional) return "";
      if (!Array.isArray(symbols) || !symbols.every((symbol) => typeof symbol === "string")) {
        throw new Error(`${manifest.name} requires a symbols array.`);
      }
      return symbols.join(",");
    }
    case "free-text": {
      const text = args.text;
      if (text == null && manifest.argument.optional) return "";
      if (typeof text !== "string") throw new Error(`${manifest.name} requires a text string.`);
      return text;
    }
  }
}

function optionArgsFor(manifest: ClientToolManifest, args: Record<string, JsonValue>): Record<string, string | true> {
  const declared = new Set(manifest.options?.map(({ key }) => key) ?? []);
  const options: Record<string, string | true> = {};
  for (const [key, value] of Object.entries(args)) {
    if (ARGUMENT_KEYS.has(key)) continue;
    if (!declared.has(key)) throw new Error(`Unknown option "${key}" for ${manifest.name}.`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Option "${key}" for ${manifest.name} must be a scalar value.`);
    }
    options[key] = value === true ? true : String(value);
  }
  return options;
}

function headlessRowCount(definition: HeadlessPaneDefinition, result: HeadlessPaneResult): number {
  switch (definition.shape) {
    case "rows":
      return (result as { rows: unknown[] }).rows.length;
    case "bundle":
      return (result as HeadlessBundleResult).sections.reduce((count, section) => (
        count + ("rows" in section && section.rows ? section.rows.length : section.entries.length)
      ), 0);
    case "series":
      return (result as HeadlessSeriesResult).series.reduce(
        (count, series) => count + series.points.length,
        0,
      );
    case "snapshot":
      return (result as HeadlessSnapshotResult).items.length;
  }
}

function inferRemoteRowCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (value == null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["rows", "items", "panes", "sections", "series", "results"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return 1;
}

function effectiveTimeoutMs(call: ASKGToolCallEvent, now: number): number {
  const declared = Math.max(0, call.timeoutMs);
  const expiresAt = Date.parse(call.expiresAt);
  if (!Number.isFinite(expiresAt)) return declared;
  return Math.max(0, Math.min(declared, expiresAt - now));
}

async function runWithDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) throw new ToolCancelledError("Tool call was cancelled.");
  if (timeoutMs <= 0) throw new ToolTimeoutError("Tool call timed out.");

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const gate = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = new ToolTimeoutError("Tool call timed out.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    if (externalSignal) {
      const onAbort = () => {
        const error = new ToolCancelledError("Tool call was cancelled.");
        controller.abort(error);
        reject(error);
      };
      externalSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => externalSignal.removeEventListener("abort", onAbort);
    }
  });

  try {
    return await Promise.race([run(controller.signal), gate]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    removeAbortListener?.();
  }
}

/**
 * Tools run inside the app, whose API client already holds the signed-in
 * session. The CLI's `withPersistedCloudSession` is for processes that start
 * signed out, and it reads `process.env`, which the desktop and web views lack.
 */
function defaultHeadlessExecutor(
  registry: PaneFunctionCatalog,
  context: MarketContext,
): HeadlessToolExecutor {
  return async ({ name, args, manifest, signal }) => {
    const rawArgument = rawArgumentFor(manifest, args);
    const resolved = await resolvePaneFunction(registry, context, {
      target: name,
      arg: rawArgument,
      options: optionArgsFor(manifest, args),
      outputPath: null,
      width: 1280,
      height: 720,
      theme: null,
      scale: 1,
      watermark: null,
      requireBotSafe: false,
    }, { strictHeadlessOptions: true });
    const loaded = await loadResolvedHeadlessPaneModel(resolved, context, rawArgument, signal);
    const result = compactHeadlessResult(loaded);
    return {
      result: serializeHeadlessPaneResult(loaded.definition, result),
      rowCount: headlessRowCount(loaded.definition, result),
      ...(result.errors?.length ? { errors: result.errors } : {}),
    };
  };
}

/**
 * What Gloom reads is the function's compact form when it has one: the view
 * that was asked for rather than every view and the full model. `fn` and the
 * pane keep the full result.
 */
function compactHeadlessResult({ definition, result, args }: LoadedHeadlessPaneModel): HeadlessPaneResult {
  if (!definition.compact) return result;
  try {
    return definition.compact(result, args);
  } catch {
    return result;
  }
}

export function createASKGToolExecutor(
  dependencies: ASKGToolExecutorDependencies,
): ASKGToolExecutor {
  const manifests = new Map(dependencies.manifests.map((manifest) => [manifest.name, manifest]));
  const now = dependencies.now ?? Date.now;
  const executeHeadless = dependencies.headlessExecutor
    ?? defaultHeadlessExecutor(dependencies.registry, dependencies.context);
  const undoManager = dependencies.undoManager ?? new ASKGUndoManager(dependencies.remoteHandler);

  const execute = async (
    call: ASKGToolCallEvent,
    options: ASKGToolExecutionOptions = {},
  ): Promise<ToolResultPayload> => {
    const startedAt = now();
    const base = (value: ExecutionValue): ToolResultPayload => withBoundedPayload({
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      status: value.status,
      ...(value.result !== undefined ? { result: normalizeJson(value.result) } : {}),
      ...(value.rowCount !== undefined ? { rowCount: value.rowCount } : {}),
      truncated: value.truncated ?? false,
      elapsedMs: Math.max(0, now() - startedAt),
      ...(value.note ? { note: capToolNote(value.note) } : {}),
      ...(value.rev ? { rev: value.rev } : {}),
      ...(value.undoToken ? { undoToken: value.undoToken } : {}),
    });

    const manifest = manifests.get(call.name);
    if (!manifest) {
      return base({ status: "denied", note: `Tool "${call.name}" was not advertised by this client.` });
    }
    if (call.writeTier !== manifest.writeTier) {
      return base({
        status: "denied",
        note: `Tool tier mismatch: advertised ${manifest.writeTier}, received ${call.writeTier}.`,
      });
    }
    if ((manifest.confirm === "always" || call.requiresConfirmation) && !options.confirmed) {
      return base({ status: "denied", note: "This tool call requires local confirmation." });
    }

    const timeoutMs = Math.min(manifest.timeoutMs, effectiveTimeoutMs(call, now()));
    try {
      const value = await runWithDeadline(async (signal): Promise<ExecutionValue> => {
        if (manifest.source === "headless") {
          const loaded = await executeHeadless({ name: call.name, args: call.args, manifest, signal });
          const errors = loaded.errors?.filter(Boolean) ?? [];
          return {
            status: errors.length > 0 ? (loaded.rowCount > 0 ? "partial" : "error") : "ok",
            result: loaded.result,
            rowCount: loaded.rowCount,
            ...(errors.length > 0 ? {
              truncated: loaded.rowCount > 0,
              note: summarizeToolWarnings(errors),
            } : {}),
          };
        }

        const binding = resolveRemoteToolBinding(call.name);
        if (!binding) throw new Error(`Remote tool "${call.name}" has no in-process binding.`);
        let preparedUndo: Awaited<ReturnType<ASKGUndoManager["prepare"]>> = null;
        let undoNote: string | undefined;
        if (manifest.writeTier === "ui-write" && binding.kind === "operation") {
          try {
            preparedUndo = await undoManager.prepare(binding.operation, call.args, signal);
          } catch (error) {
            undoNote = capToolNote(`Undo is unavailable: ${toolErrorNote(error)}`);
          }
        }

        const response = await dependencies.remoteHandler(remoteRequestForTool(binding, call.args));
        if (!response.ok) {
          return {
            status: "error",
            result: { code: response.error.code, ...(response.error.details !== undefined ? { details: response.error.details } : {}) },
            note: toolErrorNote(response.error.message),
          };
        }

        let undoToken: string | undefined;
        if (preparedUndo) {
          try {
            undoToken = await undoManager.commit(preparedUndo, signal) ?? undefined;
          } catch (error) {
            undoNote = capToolNote(`Undo is unavailable: ${toolErrorNote(error)}`);
          }
        }
        return {
          status: "ok",
          result: response.data,
          rowCount: inferRemoteRowCount(response.data),
          ...(undoNote ? { note: undoNote } : {}),
          ...(response.rev ? { rev: response.rev } : response.state?.rev ? { rev: response.state.rev } : {}),
          ...(undoToken ? { undoToken } : {}),
        };
      }, timeoutMs, options.signal);
      return base(value);
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        return base({ status: "timeout", note: "Tool call timed out." });
      }
      if (error instanceof ToolCancelledError || options.signal?.aborted) {
        return base({ status: "cancelled", note: "Tool call was cancelled." });
      }
      return base({ status: "error", note: toolErrorNote(error) });
    }
  };

  return {
    execute,
    undo: (token, signal) => undoManager.undo(token, signal),
  };
}
