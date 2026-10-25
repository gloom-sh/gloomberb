export interface PacedInputDiagnostics {
  offeredMoves: number;
  acknowledgedMoves: number;
  skippedSlots: number;
  maxPendingMoves: number;
  maxDispatchLatenessMs: number;
  drainMs: number;
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
