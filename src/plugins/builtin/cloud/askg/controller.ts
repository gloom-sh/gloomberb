import {
  ASKGTransportError,
  type ASKGToolResultOutcome,
  type ASKGTransport,
} from "../../../../api-client/askg";
import type { ASKGToolExecutor } from "./executor";
import {
  activeTurn,
  askgReducer,
  describeASKGError,
  EMPTY_ASKG_CONVERSATION,
  isTurnRunning,
  requiresLocalConfirmation,
  type ASKGAction,
  type ASKGConversationState,
  type ASKGErrorState,
} from "./model";
import {
  ASKG_PROTOCOL_VERSION,
  type ASKGClientDescriptor,
  type ASKGSessionContext,
  type ASKGSessionStartResponse,
  type ASKGSseEvent,
  type ASKGToolCallEvent,
  type ASKGTurnRequest,
  type ClientToolManifest,
  type ToolResultPayload,
} from "./protocol";

/** Turns kept as context for the next question. */
const MAX_HISTORY_TURNS = 8;

/** Ceiling used until the server states its own turn budget. */
const DEFAULT_TURN_WALL_CLOCK_MS = 120_000;
/** Sessions are renegotiated a little before they expire. */
const SESSION_EXPIRY_GRACE_MS = 5_000;

export interface ASKGControllerManifest {
  tools: ClientToolManifest[];
  manifestHash: string;
}

export interface ASKGControllerOptions {
  transport: ASKGTransport;
  loadManifest(): Promise<ASKGControllerManifest>;
  /** Null when this runtime cannot run delegated tools. */
  getExecutor(manifest: ASKGControllerManifest): ASKGToolExecutor | null;
  client: ASKGClientDescriptor;
  getContext?(): ASKGSessionContext;
  now?(): number;
  createId?(): string;
}

/**
 * How a refused delivery reads in the timeline. A result that misses its window
 * is a timed out tool, because the turn already continued with a synthetic
 * timeout for it; the other refusals describe a call the turn cannot use.
 */
function refusedResult(
  payload: ToolResultPayload,
  outcome: ASKGToolResultOutcome,
): ToolResultPayload | null {
  switch (outcome) {
    case "accepted":
    case "already-recorded":
      return null;
    case "too-late":
      return {
        ...payload,
        status: "timeout",
        note: "Took too long, so Gloom answered without it.",
      };
    case "too-large":
      return { ...payload, status: "error", note: "Result was too large to send." };
    case "unknown-call":
      return { ...payload, status: "error", note: "Gloom no longer has this tool call." };
  }
}

function errorState(error: unknown): ASKGErrorState {
  if (error instanceof ASKGTransportError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : "Ask Gloom failed.",
    retryable: true,
  };
}

/**
 * Runs one ASKG conversation: negotiates the session, reads the turn stream,
 * executes delegated tool calls locally, and posts their results back. It owns
 * no rendering, so the pane only subscribes and dispatches user intent.
 */
export class ASKGSessionController {
  private state: ASKGConversationState = EMPTY_ASKG_CONVERSATION;
  private readonly listeners = new Set<() => void>();
  private session: ASKGSessionStartResponse | null = null;
  private sessionRequest: Promise<ASKGSessionStartResponse> | null = null;
  private manifest: ASKGControllerManifest | null = null;
  private readonly confirmations = new Map<string, (approved: boolean) => void>();
  /** Calls whose turn ended while they were still waiting to be approved. */
  private readonly abandonedCalls = new Set<string>();
  private readonly toolTasks = new Set<Promise<void>>();
  private turnAbort: AbortController | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: ASKGControllerOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  }

  getState(): ASKGConversationState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private dispatch(action: ASKGAction): void {
    const next = askgReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private async ensureSession(signal: AbortSignal): Promise<ASKGSessionStartResponse> {
    const current = this.session;
    if (current && Date.parse(current.expiresAt) - SESSION_EXPIRY_GRACE_MS > this.now()) {
      return current;
    }
    if (this.sessionRequest) return this.sessionRequest;

    const request = (async () => {
      const manifest = this.manifest ?? await this.options.loadManifest();
      this.manifest = manifest;
      const session = await this.options.transport.startSession({
        protocolVersion: ASKG_PROTOCOL_VERSION,
        client: this.options.client,
        context: this.options.getContext?.() ?? {},
        tools: manifest.tools,
        manifestHash: manifest.manifestHash,
      }, { signal });
      this.session = session;
      this.dispatch({
        type: "session-started",
        sessionId: session.sessionId,
        model: session.model,
        limits: session.limits,
        acceptedTools: session.acceptedTools,
      });
      return session;
    })();

    this.sessionRequest = request;
    try {
      return await request;
    } finally {
      if (this.sessionRequest === request) this.sessionRequest = null;
    }
  }

  /** Prior questions and answers, oldest first, for the next turn's context. */
  private history(): ASKGTurnRequest["history"] {
    return this.state.turns
      .filter((turn) => turn.answer.trim().length > 0)
      .slice(-MAX_HISTORY_TURNS)
      .flatMap((turn) => ([
        { role: "user" as const, text: turn.prompt },
        { role: "assistant" as const, text: turn.answer },
      ]));
  }

  /** Asks one question and streams the answer until the turn ends. */
  async ask(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed || this.disposed || isTurnRunning(this.state)) return;

    // The turn id is the client's: a reconnect reuses it verbatim and
    // re-attaches to the same turn instead of asking again.
    const turnId = this.createId();
    const history = this.history();
    this.dispatch({ type: "prompt", turnId, prompt: trimmed, at: this.now() });

    const abort = new AbortController();
    this.turnAbort = abort;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await this.ensureSession(abort.signal);
      // A stalled stream must fail visibly rather than spin forever.
      const wallClockMs = session.limits.turnWallClockMs > 0
        ? session.limits.turnWallClockMs
        : DEFAULT_TURN_WALL_CLOCK_MS;
      deadline = setTimeout(() => {
        this.dispatch({
          type: "turn-failed",
          turnId,
          error: {
            code: "turn_timeout",
            message: "Gloom stopped responding before the answer finished.",
            retryable: true,
          },
        });
        this.abandonPendingConfirmations();
        abort.abort();
      }, wallClockMs);

      await this.options.transport.streamTurn(session.sessionId, {
        protocolVersion: ASKG_PROTOCOL_VERSION,
        turnId,
        input: trimmed,
        ...(this.options.getContext ? { context: this.options.getContext() } : {}),
        ...(history && history.length > 0 ? { history } : {}),
      }, {
        signal: abort.signal,
        onEvent: (event) => this.handleEvent(event),
      });
      // Tool calls delivered late in the stream may still be running.
      await Promise.allSettled([...this.toolTasks]);
    } catch (error) {
      if (!abort.signal.aborted) {
        this.dispatch({ type: "turn-failed", turnId, error: errorState(error) });
      }
      this.abandonPendingConfirmations();
    } finally {
      if (deadline) clearTimeout(deadline);
      if (this.turnAbort === abort) this.turnAbort = null;
      const turn = activeTurn(this.state);
      // The stream can end without a `done` event after a resume gives up.
      if (turn?.id === turnId && turn.status === "streaming") {
        this.dispatch({
          type: "turn-failed",
          turnId,
          error: {
            code: "network",
            message: "The answer stream ended before it finished.",
            retryable: true,
          },
        });
      }
    }
  }

  private handleEvent(event: ASKGSseEvent): void {
    this.dispatch({ type: "event", event });
    if (event.type === "done") {
      // Nothing is worth approving once the turn is over.
      this.abandonPendingConfirmations();
      return;
    }
    if (event.type !== "tool-call") return;
    const task = this.runToolCall(event).finally(() => {
      this.toolTasks.delete(task);
    });
    this.toolTasks.add(task);
  }

  private async runToolCall(call: ASKGToolCallEvent): Promise<void> {
    const signal = this.turnAbort?.signal;
    const startedAt = this.now();
    const failure = (note: string): ToolResultPayload => ({
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      status: "error",
      truncated: false,
      elapsedMs: Math.max(0, this.now() - startedAt),
      note,
    });

    const accepted = this.state.acceptedTools;
    if (accepted.length > 0 && !accepted.includes(call.name)) {
      await this.deliver({
        turnId: call.turnId,
        toolCallId: call.toolCallId,
        status: "denied",
        truncated: false,
        elapsedMs: 0,
        note: `"${call.name}" was not accepted by this session.`,
      });
      return;
    }

    try {
      let confirmed = false;
      if (requiresLocalConfirmation(call)) {
        this.dispatch({ type: "tool-awaiting-confirmation", toolCallId: call.toolCallId });
        confirmed = await new Promise<boolean>((resolve) => {
          this.confirmations.set(call.toolCallId, resolve);
        });
        if (this.abandonedCalls.delete(call.toolCallId)) return;
        if (!confirmed) {
          await this.deliver({
            turnId: call.turnId,
            toolCallId: call.toolCallId,
            status: "denied",
            truncated: false,
            elapsedMs: Math.max(0, this.now() - startedAt),
            note: "You declined this action.",
          });
          return;
        }
      }

      this.dispatch({ type: "tool-running", toolCallId: call.toolCallId });
      const manifest = this.manifest ?? await this.options.loadManifest();
      this.manifest = manifest;
      const executor = this.options.getExecutor(manifest);
      if (!executor) {
        await this.deliver(failure("This window cannot run Gloomberb tools."));
        return;
      }
      const payload = await executor.execute(call, {
        confirmed: confirmed || !requiresLocalConfirmation(call),
        ...(signal ? { signal } : {}),
      });
      await this.deliver(payload);
    } catch (error) {
      await this.deliver(failure(
        error instanceof Error ? error.message : "The tool call failed locally.",
      ));
    } finally {
      this.confirmations.delete(call.toolCallId);
    }
  }

  /** Records a tool result locally, then posts it to the turn loop. */
  private async deliver(payload: ToolResultPayload): Promise<void> {
    this.dispatch({ type: "tool-result", payload });
    const sessionId = this.session?.sessionId;
    if (!sessionId) return;
    try {
      const outcome = await this.options.transport.postToolResult(sessionId, payload, {
        ...(this.turnAbort ? { signal: this.turnAbort.signal } : {}),
      });
      const refused = refusedResult(payload, outcome);
      if (refused) this.dispatch({ type: "tool-result", payload: refused });
    } catch (error) {
      const note = `${payload.note ? `${payload.note} ` : ""}Result could not be delivered: ${describeASKGError(errorState(error))}`;
      this.dispatch({ type: "tool-result", payload: { ...payload, note } });
    }
  }

  /** Answers a `user-data` or `broker` confirmation prompt. */
  resolveConfirmation(toolCallId: string, approved: boolean): void {
    const resolve = this.confirmations.get(toolCallId);
    if (!resolve) return;
    this.confirmations.delete(toolCallId);
    resolve(approved);
  }

  private rejectPendingConfirmations(): void {
    for (const [toolCallId, resolve] of [...this.confirmations]) {
      this.confirmations.delete(toolCallId);
      resolve(false);
    }
  }

  /** Drops confirmations whose answer can no longer reach the turn. */
  private abandonPendingConfirmations(): void {
    for (const toolCallId of this.confirmations.keys()) this.abandonedCalls.add(toolCallId);
    this.rejectPendingConfirmations();
  }

  setExpanded(toolCallId: string, expanded: boolean): void {
    this.dispatch({ type: "tool-expanded", toolCallId, expanded });
  }

  /** Reverts a `ui-write` tool call through the undo token it returned. */
  async undo(toolCallId: string): Promise<void> {
    const row = this.state.turns
      .flatMap((turn) => turn.tools)
      .find((entry) => entry.toolCallId === toolCallId);
    if (!row?.undoToken || row.undo?.status === "running") return;
    const manifest = this.manifest ?? await this.options.loadManifest();
    this.manifest = manifest;
    const executor = this.options.getExecutor(manifest);
    if (!executor) {
      this.dispatch({
        type: "undo",
        toolCallId,
        undo: { status: "failed", note: "This window cannot undo tool calls." },
      });
      return;
    }
    this.dispatch({ type: "undo", toolCallId, undo: { status: "running" } });
    try {
      const applied = await executor.undo(row.undoToken);
      this.dispatch({
        type: "undo",
        toolCallId,
        undo: applied.status === "ok"
          ? { status: "done" }
          : { status: "failed", ...(applied.note ? { note: applied.note } : {}) },
      });
    } catch (error) {
      this.dispatch({
        type: "undo",
        toolCallId,
        undo: {
          status: "failed",
          note: error instanceof Error ? error.message : "Undo failed.",
        },
      });
    }
  }

  /** Stops the current turn locally and tells the server to stop too. */
  cancel(): void {
    const turn = activeTurn(this.state);
    this.abandonPendingConfirmations();
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (turn) this.dispatch({ type: "turn-cancelled", turnId: turn.id });
    const sessionId = this.session?.sessionId;
    const remoteTurnId = turn?.remoteTurnId;
    if (sessionId && remoteTurnId) {
      void this.options.transport.cancelTurn(sessionId, remoteTurnId).catch(() => {});
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abandonPendingConfirmations();
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.listeners.clear();
  }
}
