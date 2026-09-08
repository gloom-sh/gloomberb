import {
  ASKG_PROTOCOL_VERSION,
  type ASKGDoneReason,
  type ASKGErrorCode,
  type ASKGSessionStartRequest,
  type ASKGSessionStartResponse,
  type ASKGSseEvent,
  type ASKGTurnRequest,
  type ToolResultPayload,
} from "../plugins/builtin/cloud/askg/protocol";
import { ApiRequestError } from "./errors";
import { STREAMING_UNSUPPORTED_STATUS } from "./request";

/** Client-side failure codes, layered on top of the wire error codes. */
export type ASKGClientErrorCode =
  | ASKGErrorCode
  | "transport_unsupported"
  | "tier_required"
  | "unauthorized"
  | "network"
  | "protocol";

/**
 * What the tool-result route made of a posted result. Only `too-late` changes
 * what the user sees: the turn already continued with a synthetic timeout.
 */
export type ASKGToolResultOutcome =
  | "accepted"
  | "unknown-call"
  | "too-late"
  | "too-large"
  | "already-recorded";

export class ASKGTransportError extends Error {
  constructor(
    readonly code: ASKGClientErrorCode,
    message: string,
    readonly options: { retryable?: boolean; retryAfterMs?: number; status?: number } = {},
  ) {
    super(message);
    this.name = "ASKGTransportError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

export interface ASKGStreamOptions {
  signal?: AbortSignal;
  onEvent(event: ASKGSseEvent): void;
  /** Highest `seq` already applied, so a resumed stream skips what was seen. */
  lastEventId?: number;
}

export interface ASKGTransport {
  isStreamingSupported(): boolean;
  startSession(
    request: ASKGSessionStartRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ASKGSessionStartResponse>;
  streamTurn(
    sessionId: string,
    request: ASKGTurnRequest,
    options: ASKGStreamOptions,
  ): Promise<ASKGDoneReason | null>;
  postToolResult(
    sessionId: string,
    payload: ToolResultPayload,
    options?: { signal?: AbortSignal },
  ): Promise<ASKGToolResultOutcome>;
  cancelTurn(
    sessionId: string,
    turnId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

/** One decoded server-sent event frame. */
export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental server-sent events decoder. Chunk boundaries never line up with
 * frame boundaries, so the trailing partial line is held until more bytes
 * arrive and only a blank line dispatches a frame.
 */
export function createSseDecoder(): {
  push(chunk: string): SseFrame[];
  flush(): SseFrame[];
} {
  let buffer = "";
  let dataLines: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  const takeFrame = (): SseFrame | null => {
    if (dataLines.length === 0 && event === undefined && id === undefined) return null;
    const frame: SseFrame = {
      data: dataLines.join("\n"),
      ...(id !== undefined ? { id } : {}),
      ...(event !== undefined ? { event } : {}),
    };
    dataLines = [];
    event = undefined;
    id = undefined;
    return frame.data ? frame : null;
  };

  const consumeLine = (line: string, frames: SseFrame[]): void => {
    if (line === "") {
      const frame = takeFrame();
      if (frame) frames.push(frame);
      return;
    }
    // A leading colon is a comment, used for keep-alive pings.
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  };

  return {
    push(chunk) {
      const frames: SseFrame[] = [];
      buffer += chunk;
      // \r\n, \n, and \r are all valid SSE line terminators.
      let match = buffer.match(/\r\n|\n|\r/);
      while (match?.index !== undefined) {
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consumeLine(line, frames);
        match = buffer.match(/\r\n|\n|\r/);
      }
      return frames;
    },
    flush() {
      const frames: SseFrame[] = [];
      if (buffer) {
        consumeLine(buffer, frames);
        buffer = "";
      }
      const frame = takeFrame();
      if (frame) frames.push(frame);
      return frames;
    },
  };
}

function isAskgEvent(value: unknown): value is ASKGSseEvent {
  if (value == null || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; seq?: unknown };
  return typeof candidate.type === "string" && typeof candidate.seq === "number";
}

/** Parses one frame payload, ignoring keep-alives and unknown shapes. */
export function parseASKGFrame(frame: SseFrame): ASKGSseEvent | null {
  const data = frame.data.trim();
  if (!data || data === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isAskgEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ReadASKGStreamOptions {
  onEvent(event: ASKGSseEvent): void;
  /** Events at or below this `seq` were already applied before a resume. */
  lastSeq?: number;
  signal?: AbortSignal;
}

export interface ASKGStreamOutcome {
  /** Highest applied `seq`, used as `Last-Event-ID` when resuming. */
  lastSeq: number;
  /** Set when the stream carried a terminal `done` event. */
  done: ASKGDoneReason | null;
}

/**
 * Drains one SSE body into typed events. Duplicate and replayed events are
 * dropped by `seq` so a resumed stream is idempotent for the caller.
 */
export async function readASKGEventStream(
  body: ReadableStream<Uint8Array>,
  options: ReadASKGStreamOptions,
): Promise<ASKGStreamOutcome> {
  const decoder = new TextDecoder();
  const sse = createSseDecoder();
  const reader = body.getReader();
  let lastSeq = options.lastSeq ?? 0;
  let done: ASKGDoneReason | null = null;

  const applyFrames = (frames: SseFrame[]): void => {
    for (const frame of frames) {
      const event = parseASKGFrame(frame);
      if (!event || event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      if (event.type === "done") done = event.reason;
      options.onEvent(event);
    }
  };

  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      applyFrames(sse.push(decoder.decode(chunk.value, { stream: true })));
      if (done) break;
    }
    if (!done) applyFrames(sse.flush());
    return { lastSeq, done };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try {
      reader.releaseLock?.();
    } catch {
      // A reader cancelled mid-read cannot release its lock; nothing to undo.
    }
  }
}

/** Number of times a dropped stream is reopened with `Last-Event-ID`. */
const MAX_STREAM_RESUMES = 2;
const RESUME_BACKOFF_MS = 250;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** A 429 covers both the per-minute limit and the daily cap. */
function rateLimitCode(message: string): "rate_limited" | "daily_turn_cap" {
  return /\bdaily\b|\bday\b|daily_turn_cap/i.test(message) ? "daily_turn_cap" : "rate_limited";
}

/** Maps an HTTP failure onto the same codes the stream itself reports. */
export function classifyASKGRequestError(error: unknown): ASKGTransportError {
  if (error instanceof ASKGTransportError) return error;
  if (error instanceof ApiRequestError) {
    if (error.status === STREAMING_UNSUPPORTED_STATUS) {
      return new ASKGTransportError(
        "transport_unsupported",
        "Ask Gloom needs a streaming connection, which this window cannot open.",
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new ASKGTransportError("unauthorized", "Sign in to Gloom Cloud to ask Gloom.", {
        status: error.status,
      });
    }
    if (error.status === 429) {
      return new ASKGTransportError(
        rateLimitCode(error.message),
        error.message || "Too many requests.",
        {
          retryable: true,
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          status: error.status,
        },
      );
    }
    if (error.status === 402) {
      return new ASKGTransportError(
        "tier_required",
        error.message || "Ask Gloom is part of a paid plan.",
        { status: error.status },
      );
    }
    if (error.status === 426) {
      return new ASKGTransportError(
        "protocol",
        `Ask Gloom no longer speaks protocol v${ASKG_PROTOCOL_VERSION}. Update Gloomberb.`,
        { status: error.status },
      );
    }
    if (error.status === 503) {
      return new ASKGTransportError("model_unavailable", error.message || "Ask Gloom is unavailable.", {
        retryable: true,
        status: error.status,
      });
    }
    return new ASKGTransportError("internal", error.message || "Ask Gloom failed.", {
      status: error.status,
    });
  }
  if (isAbortError(error)) {
    return new ASKGTransportError("network", "Ask Gloom was cancelled.");
  }
  return new ASKGTransportError(
    "network",
    error instanceof Error ? error.message : "Ask Gloom could not reach the server.",
    { retryable: true },
  );
}

interface CloudASKGApiOptions {
  request<T>(path: string, options?: RequestInit): Promise<T>;
  openStream(path: string, options?: RequestInit): Promise<Response>;
  isStreamingSupported(): boolean;
  /** Overridable so tests do not wait on real backoff. */
  delay?(ms: number, signal?: AbortSignal): Promise<void>;
}

async function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Streaming client for the ASKG turn protocol. `apiClient.request` buffers and
 * JSON-parses every response, so the turn stream takes its own path and keeps
 * the body live; the session, tool result, and cancel calls stay on the normal
 * request path.
 */
export class CloudASKGApi implements ASKGTransport {
  private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: CloudASKGApiOptions) {
    this.delay = options.delay ?? defaultDelay;
  }

  isStreamingSupported(): boolean {
    return this.options.isStreamingSupported();
  }

  async startSession(
    request: ASKGSessionStartRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ASKGSessionStartResponse> {
    try {
      const response = await this.options.request<ASKGSessionStartResponse>("/askg/session", {
        method: "POST",
        body: JSON.stringify(request),
        signal: options.signal,
      });
      if (response?.protocolVersion !== ASKG_PROTOCOL_VERSION) {
        throw new ASKGTransportError(
          "protocol",
          `Ask Gloom speaks protocol v${response?.protocolVersion ?? "?"}, this build speaks v${ASKG_PROTOCOL_VERSION}. Update Gloomberb.`,
        );
      }
      return response;
    } catch (error) {
      throw classifyASKGRequestError(error);
    }
  }

  /**
   * Reads one turn. A stream that drops before `done` is reopened with the same
   * `turnId` and `Last-Event-ID` set to the highest applied `seq`, which
   * re-attaches to the running turn instead of starting another one.
   */
  async streamTurn(
    sessionId: string,
    request: ASKGTurnRequest,
    options: ASKGStreamOptions,
  ): Promise<ASKGDoneReason | null> {
    if (!this.isStreamingSupported()) {
      throw new ASKGTransportError(
        "transport_unsupported",
        "Ask Gloom needs a streaming connection, which this window cannot open.",
      );
    }

    let lastSeq = options.lastEventId ?? 0;
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.options.openStream(
          `/askg/session/${encodeURIComponent(sessionId)}/turn`,
          {
            method: "POST",
            body: JSON.stringify({ protocolVersion: ASKG_PROTOCOL_VERSION, ...request }),
            signal: options.signal,
            headers: lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : undefined,
          },
        );
      } catch (error) {
        const transportError = classifyASKGRequestError(error);
        // Only a dropped connection is worth reopening; a refusal is final.
        if (
          transportError.code !== "network"
          || attempt >= MAX_STREAM_RESUMES
          || options.signal?.aborted
          || lastSeq === 0
        ) {
          throw transportError;
        }
        attempt += 1;
        await this.delay(RESUME_BACKOFF_MS * attempt, options.signal);
        continue;
      }

      if (!response.body) {
        throw new ASKGTransportError(
          "transport_unsupported",
          "Ask Gloom needs a streaming connection, which this window cannot open.",
        );
      }

      try {
        const outcome = await readASKGEventStream(response.body, {
          onEvent: options.onEvent,
          lastSeq,
          signal: options.signal,
        });
        if (outcome.done) return outcome.done;
        lastSeq = outcome.lastSeq;
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) return null;
        const outcomeError = classifyASKGRequestError(error);
        if (attempt >= MAX_STREAM_RESUMES) throw outcomeError;
        attempt += 1;
        await this.delay(RESUME_BACKOFF_MS * attempt, options.signal);
        continue;
      }

      if (options.signal?.aborted) return null;
      if (attempt >= MAX_STREAM_RESUMES) {
        throw new ASKGTransportError(
          "network",
          "The answer stream ended before it finished.",
          { retryable: true },
        );
      }
      attempt += 1;
      await this.delay(RESUME_BACKOFF_MS * attempt, options.signal);
    }
  }

  /**
   * Posts one client tool result. The idempotency key is the tool call id, so a
   * result redelivered after a resume is recorded once. Refusals that describe
   * the call rather than the connection are returned instead of thrown: the
   * turn is still running and the timeline says what happened to the row.
   */
  async postToolResult(
    sessionId: string,
    payload: ToolResultPayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<ASKGToolResultOutcome> {
    try {
      await this.options.request<void>(
        `/askg/session/${encodeURIComponent(sessionId)}/tool-result`,
        {
          method: "POST",
          body: JSON.stringify(payload),
          // The route requires the header and the body to name the same call.
          headers: { "Idempotency-Key": payload.toolCallId },
          signal: options.signal,
        },
      );
      // 200 and 202 both mean the turn has the result; the buffered request
      // path does not surface which one answered.
      return "accepted";
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.status === 404) return "unknown-call";
        if (error.status === 410) return "too-late";
        if (error.status === 413) return "too-large";
        if (error.status === 409) return "already-recorded";
      }
      throw classifyASKGRequestError(error);
    }
  }

  async cancelTurn(
    sessionId: string,
    turnId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    try {
      await this.options.request<void>(
        `/askg/session/${encodeURIComponent(sessionId)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ turnId }),
          signal: options.signal,
        },
      );
    } catch (error) {
      throw classifyASKGRequestError(error);
    }
  }
}
