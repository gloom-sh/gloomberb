export interface PacedInputDiagnostics {
  offeredMoves: number;
  acknowledgedMoves: number;
  skippedSlots: number;
  maxPendingMoves: number;
  maxDispatchLatenessMs: number;
  drainMs: number;
}

export interface InputWindowDiagnostics extends PacedInputDiagnostics {
  trustedSamples: number;
  pointerCallbacks: number;
  recordingMs: number;
}

/** Only a completely accounted-for shortfall in offered input can be retried. */
export class InvalidInputWindowError extends Error {
  readonly retryableDriverWindow: boolean;

  constructor(readonly diagnostics: InputWindowDiagnostics, targetMoves: number, minimumMoves: number, minimumRate: number) {
    const d = diagnostics;
    const rate = d.trustedSamples / (d.recordingMs / 1000);
    super(`Input delivery was undersampled or inconsistent: ${d.trustedSamples} trusted samples at ${Number(rate.toFixed(1))}/s; need at least ${minimumMoves} samples and ${minimumRate}/s to measure the 60Hz workload. ${JSON.stringify(d)}`);
    this.name = "InvalidInputWindowError";
    this.retryableDriverWindow = [targetMoves, minimumMoves, d.offeredMoves, d.acknowledgedMoves,
      d.skippedSlots, d.maxPendingMoves, d.trustedSamples, d.pointerCallbacks].every(Number.isInteger)
      && targetMoves >= minimumMoves && minimumMoves > 0
      && Number.isFinite(minimumRate) && minimumRate > 0
      && d.offeredMoves > 0 && d.offeredMoves < minimumMoves
      && d.offeredMoves === d.acknowledgedMoves && d.offeredMoves === d.trustedSamples
      && d.skippedSlots > 0 && d.offeredMoves + d.skippedSlots === targetMoves
      && d.pointerCallbacks > 0 && d.pointerCallbacks <= d.trustedSamples
      && d.maxPendingMoves > 0 && d.maxPendingMoves <= d.offeredMoves
      && [d.maxDispatchLatenessMs, d.drainMs, d.recordingMs].every(Number.isFinite)
      && d.maxDispatchLatenessMs >= 0 && d.drainMs >= 0 && d.recordingMs > 0
      // Even a full target must still fit the rate gate, and draining may
      // consume at most one interval at that rate. Slow delivery stays fatal.
      && d.recordingMs <= targetMoves / minimumRate * 1000
      && d.drainMs <= 1000 / minimumRate;
  }
}

/** Offer native input on a wall clock, independently of the renderer's acknowledgements. */
export async function paceInput(
  send: (progress: number) => Promise<void>,
  { durationMs, intervalMs, now = performance.now.bind(performance), wait = Bun.sleep }: {
    durationMs: number;
    intervalMs: number;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<unknown>;
  },
): Promise<PacedInputDiagnostics> {
  const began = now();
  const slots = Math.ceil(durationMs / intervalMs);
  const pending: Promise<void>[] = [];
  const failures: unknown[] = [];
  let offeredMoves = 0, acknowledgedMoves = 0, inFlight = 0, maxPendingMoves = 0, maxDispatchLatenessMs = 0;
  const waitUntil = async (deadline: number) => {
    while (now() < deadline) await wait(deadline - now());
  };
  try {
    for (let slot = 0; slot < slots; slot += 1) {
      const deadline = began + slot * intervalMs;
      await waitUntil(deadline);
      const elapsed = now() - began;
      maxDispatchLatenessMs = Math.max(maxDispatchLatenessMs, elapsed - slot * intervalMs);
      if (elapsed >= durationMs || failures.length) break;
      // A late driver sends this slot's position once; missed slots are not
      // replayed in a burst that could satisfy the delivery count artificially.
      slot = Math.max(slot, Math.floor(elapsed / intervalMs));
      offeredMoves += 1;
      inFlight += 1;
      maxPendingMoves = Math.max(maxPendingMoves, inFlight);
      let dispatch: Promise<void>;
      try { dispatch = send(elapsed / durationMs); }
      catch (error) { dispatch = Promise.reject(error); }
      // Attach both handlers immediately: an early rejected dispatch must not
      // become unhandled while later slots are still being offered.
      pending.push(dispatch.then(
        () => { acknowledgedMoves += 1; inFlight -= 1; },
        (error) => { failures.push(error); inFlight -= 1; },
      ));
    }
    await waitUntil(began + durationMs);
  } catch (error) {
    failures.push(error);
  }
  const stoppedOfferingAt = now();
  await Promise.all(pending);
  const diagnostics = {
    offeredMoves, acknowledgedMoves, skippedSlots: slots - offeredMoves, maxPendingMoves,
    maxDispatchLatenessMs, drainMs: now() - stoppedOfferingAt,
  };
  if (failures.length) {
    throw new AggregateError(failures, `Native input dispatch failed: ${String(failures[0])}; ${JSON.stringify(diagnostics)}`);
  }
  return diagnostics;
}
