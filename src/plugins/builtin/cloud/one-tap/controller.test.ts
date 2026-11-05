import { describe, expect, test } from "bun:test";
import { ApiRequestError, parseApiErrorCode, parseApiErrorMessage } from "../../../../api-client/errors";
import {
  ONE_TAP_EXPERIMENT,
  ONE_TAP_ON_SCREEN_MS,
  ONE_TAP_SNOOZE_MS,
  OneTapController,
  oneTapFailureReason,
  type OneTapDeps,
} from "./controller";
import {
  browserSupportsOneTap,
  describeMoment,
  type GoogleIdApi,
  type GoogleIdConfiguration,
  type GooglePromptNotification,
} from "./google-identity";

/** A clock and timers the test moves by hand. */
function manualClock() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = target;
    },
  };
}

/** Google's `google.accounts.id`, recording what the terminal asked of it. */
function fakeGoogle() {
  const calls: string[] = [];
  let config: GoogleIdConfiguration | null = null;
  let listener: ((notification: GooglePromptNotification) => void) | null = null;
  const api: GoogleIdApi = {
    initialize(next) {
      config = next;
      calls.push("initialize");
    },
    prompt(next) {
      listener = next ?? null;
      calls.push("prompt");
    },
    cancel() {
      calls.push("cancel");
      listener?.({ getMomentType: () => "dismissed", getDismissedReason: () => "cancel_called" });
    },
  };
  return {
    api,
    calls,
    config: () => config,
    /** What Chrome reports with FedCM: moments without display or skip reasons. */
    skip: () => listener?.({ getMomentType: () => "skipped" }),
    dismiss: (reason: string) => listener?.({ getMomentType: () => "dismissed", getDismissedReason: () => reason }),
    pick: (credential: string) => config?.callback({ credential, select_by: "fedcm" }),
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await Bun.sleep(0);
}

function setup(options: { arm?: string | null; snoozedAt?: number | null; clientId?: () => Promise<string>; signIn?: OneTapDeps["signIn"] } = {}) {
  const clock = manualClock();
  const google = fakeGoogle();
  const exposures: string[] = [];
  const recorded: Array<[string, string | undefined]> = [];
  const signIns: string[] = [];
  let snoozedAt = options.snoozedAt ?? null;
  const controller = new OneTapController({
    expose: async () => {
      exposures.push(ONE_TAP_EXPERIMENT);
      return options.arm === undefined ? "one_tap" : options.arm;
    },
    clientId: options.clientId ?? (async () => "google-client"),
    google: async () => google.api,
    signIn: options.signIn ?? (async (credential) => {
      signIns.push(credential);
    }),
    record: (event, reason) => recorded.push([event, reason]),
    snoozedAt: () => snoozedAt,
    snooze: (at) => {
      snoozedAt = at;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, google, controller, exposures, recorded, signIns, snoozedAt: () => snoozedAt };
}

/** A signed-out visitor who opened a function and stayed the minute. */
async function eligible(run: ReturnType<typeof setup>) {
  run.controller.update({ visible: true, signedOut: true, overlayOpen: false });
  run.controller.noteFunctionOpen();
  run.clock.advance(ONE_TAP_ON_SCREEN_MS);
  await settle();
}

describe("One Tap eligibility", () => {
  test("is never at first paint: it takes a function of the visitor's own and a minute on screen", async () => {
    const run = setup();
    run.controller.update({ visible: true, signedOut: true, overlayOpen: false });
    run.clock.advance(ONE_TAP_ON_SCREEN_MS * 10);
    await settle();
    // Ten minutes looking at the starter screen is not use.
    expect(run.exposures).toEqual([]);

    run.controller.noteFunctionOpen();
    await settle();
    expect(run.exposures).toEqual([ONE_TAP_EXPERIMENT]);
  });

  test("counts only the time the tab is on screen", async () => {
    const run = setup();
    run.controller.update({ visible: true, signedOut: true, overlayOpen: false });
    run.controller.noteFunctionOpen();
    run.clock.advance(ONE_TAP_ON_SCREEN_MS / 2);
    run.controller.update({ visible: false });
    run.clock.advance(60 * ONE_TAP_ON_SCREEN_MS);
    await settle();
    expect(run.exposures).toEqual([]);

    run.controller.update({ visible: true });
    run.clock.advance(ONE_TAP_ON_SCREEN_MS / 2 - 1);
    await settle();
    expect(run.exposures).toEqual([]);
    run.clock.advance(1);
    await settle();
    expect(run.exposures).toEqual([ONE_TAP_EXPERIMENT]);
  });

  test("waits for an open dialog or the command bar to close", async () => {
    const run = setup();
    run.controller.update({ visible: true, signedOut: true, overlayOpen: true });
    run.controller.noteFunctionOpen();
    run.clock.advance(ONE_TAP_ON_SCREEN_MS * 3);
    await settle();
    expect(run.exposures).toEqual([]);
    run.controller.update({ overlayOpen: false });
    await settle();
    expect(run.exposures).toEqual([ONE_TAP_EXPERIMENT]);
    expect(run.google.calls).toEqual(["initialize", "prompt"]);
  });

  test("never asks for a signed-in account", async () => {
    const run = setup();
    run.controller.update({ visible: true, signedOut: false, overlayOpen: false });
    run.controller.noteFunctionOpen();
    run.clock.advance(ONE_TAP_ON_SCREEN_MS * 3);
    await settle();
    expect(run.exposures).toEqual([]);
  });
});

describe("One Tap arms", () => {
  test("the control is counted at the same moment and sees nothing", async () => {
    const run = setup({ arm: "control" });
    await eligible(run);
    expect(run.exposures).toEqual([ONE_TAP_EXPERIMENT]);
    expect(run.google.calls).toEqual([]);
    expect(run.recorded).toEqual([]);
    expect(run.controller.phase).toBe("done");
  });

  test("a visitor outside the experiment sees nothing either", async () => {
    const run = setup({ arm: null });
    await eligible(run);
    expect(run.exposures).toHaveLength(1);
    expect(run.google.calls).toEqual([]);
  });

  test("one_tap asks Google once, on the server's client, for a click and never a silent sign-in", async () => {
    const run = setup();
    await eligible(run);
    expect(run.exposures).toEqual([ONE_TAP_EXPERIMENT]);
    expect(run.google.calls).toEqual(["initialize", "prompt"]);
    expect(run.google.config()).toMatchObject({
      client_id: "google-client",
      auto_select: false,
      context: "use",
      use_fedcm_for_prompt: true,
    });
    expect(run.recorded).toEqual([["one_tap_prompted", undefined]]);
    run.clock.advance(ONE_TAP_ON_SCREEN_MS * 10);
    run.controller.noteFunctionOpen();
    await settle();
    expect(run.exposures).toHaveLength(1);
  });

  test("a snoozed one_tap visitor is still counted, and is not prompted", async () => {
    const run = setup({ snoozedAt: 1_000_000 - ONE_TAP_SNOOZE_MS + ONE_TAP_ON_SCREEN_MS * 2 });
    await eligible(run);
    expect(run.exposures).toHaveLength(1);
    expect(run.google.calls).toEqual([]);
    expect(run.recorded).toEqual([["one_tap_not_shown", "snoozed"]]);
  });

  test("once the snooze is over the prompt comes back", async () => {
    const run = setup({ snoozedAt: 1_000_000 - ONE_TAP_SNOOZE_MS });
    await eligible(run);
    expect(run.google.calls).toEqual(["initialize", "prompt"]);
  });

  test("with One Tap off on the server nothing shows", async () => {
    const run = setup({ clientId: async () => { throw new ApiRequestError("One Tap is off", 404); } });
    await eligible(run);
    expect(run.google.calls).toEqual([]);
    expect(run.recorded).toEqual([["one_tap_not_shown", "unavailable"]]);
  });
});

describe("One Tap prompt", () => {
  test("a closed prompt is recorded and stays away for a week", async () => {
    const run = setup();
    await eligible(run);
    run.google.skip();
    expect(run.recorded.at(-1)).toEqual(["one_tap_skipped", "unknown_reason"]);
    expect(run.snoozedAt()).toBe(run.clock.now());
    expect(run.controller.phase).toBe("done");
  });

  test("a picked account signs in where the visitor is, and is recorded", async () => {
    const run = setup();
    await eligible(run);
    run.google.dismiss("credential_returned");
    run.google.pick("id-token");
    await settle();
    expect(run.signIns).toEqual(["id-token"]);
    expect(run.recorded).toEqual([
      ["one_tap_prompted", undefined],
      ["one_tap_dismissed", "credential_returned"],
      ["one_tap_signed_in", undefined],
    ]);
    expect(run.snoozedAt()).toBeNull();
  });

  test("a sign-in the server refuses for that Google account is recorded with why, and rests like a dismissal", async () => {
    for (const [error, reason] of [
      [refusal(401, { message: "account not linked" }), "account_not_linked"],
      [refusal(403, { code: "email_not_verified", message: "Verify this email with the provider first." }), "email_not_verified"],
    ] as const) {
      const run = setup({ signIn: async () => { throw error; } });
      await eligible(run);
      run.google.pick("id-token");
      await settle();
      expect(run.recorded.at(-1)).toEqual(["one_tap_failed", reason]);
      expect(run.snoozedAt()).toBe(run.clock.now());
      expect(run.controller.phase).toBe("done");
    }
  });

  test("a sign-in that fails on the way is recorded, and the prompt may come back on a later visit", async () => {
    const run = setup({ signIn: async () => { throw new TypeError("Failed to fetch"); } });
    await eligible(run);
    run.google.pick("id-token");
    await settle();
    expect(run.recorded.at(-1)).toEqual(["one_tap_failed", "error"]);
    expect(run.snoozedAt()).toBeNull();
  });

  test("a dialog opening over the prompt cancels it, and it comes back when the dialog closes", async () => {
    const run = setup();
    await eligible(run);
    run.controller.update({ overlayOpen: true });
    expect(run.google.calls).toEqual(["initialize", "prompt", "cancel"]);
    expect(run.recorded.at(-1)).toEqual(["one_tap_dismissed", "cancel_called"]);
    // The terminal's own cancel is not the visitor's answer.
    expect(run.snoozedAt()).toBeNull();
    run.controller.update({ overlayOpen: false });
    expect(run.google.calls).toEqual(["initialize", "prompt", "cancel", "prompt"]);
    // Only one exposure, whatever happens to the prompt.
    expect(run.exposures).toHaveLength(1);
  });

  test("signing in some other way takes the prompt down", async () => {
    const run = setup();
    await eligible(run);
    run.controller.update({ signedOut: false });
    expect(run.google.calls.at(-1)).toBe("cancel");
    expect(run.controller.phase).toBe("done");
  });
});

describe("describeMoment", () => {
  test("reads Google's reasons where it gives them, and FedCM's moments without them", () => {
    expect(describeMoment({ getMomentType: () => "display", isDisplayed: () => true })).toEqual({ event: "one_tap_shown" });
    expect(describeMoment({
      getMomentType: () => "display",
      isDisplayed: () => false,
      getNotDisplayedReason: () => "opt_out_or_no_session",
    })).toEqual({ event: "one_tap_not_shown", reason: "opt_out_or_no_session" });
    expect(describeMoment({ getMomentType: () => "skipped", getSkippedReason: () => "tap_outside" }))
      .toEqual({ event: "one_tap_skipped", reason: "tap_outside" });
    expect(describeMoment({ getMomentType: () => "skipped", getSkippedReason: () => { throw new Error("removed with FedCM"); } }))
      .toEqual({ event: "one_tap_skipped", reason: "unknown_reason" });
    expect(describeMoment({ getMomentType: () => "skipped", getSkippedReason: () => "Jane Doe" }))
      .toEqual({ event: "one_tap_skipped", reason: "unknown_reason" });
    // Only the reasons the server knows: a new one from Google is unknown_reason.
    expect(describeMoment({ getMomentType: () => "skipped", getSkippedReason: () => "some_new_reason" }))
      .toEqual({ event: "one_tap_skipped", reason: "unknown_reason" });
    expect(describeMoment({ getMomentType: () => "dismissed", getDismissedReason: () => "credential_returned" }))
      .toEqual({ event: "one_tap_dismissed", reason: "credential_returned" });
    expect(describeMoment({})).toBeNull();
  });
});

/** The error the API client throws for this answer. */
function refusal(status: number, body: unknown): ApiRequestError {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new ApiRequestError(parseApiErrorMessage(text), status, undefined, parseApiErrorCode(text));
}

test("tells the server's refusals apart by its words, never by the status alone", () => {
  expect(oneTapFailureReason(refusal(401, { message: "account not linked" }))).toBe("account_not_linked");
  expect(oneTapFailureReason(refusal(403, { code: "email_not_verified", message: "Verify this email with the provider first." })))
    .toBe("email_not_verified");
  expect(oneTapFailureReason(refusal(403, { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }))).toBe("email_not_verified");
  // A 403 from something else on the way (a proxy, the origin check) is not about the email.
  expect(oneTapFailureReason(refusal(403, { message: "Invalid origin" }))).toBe("error");
  expect(oneTapFailureReason(refusal(403, "<html><title>api.gloom.sh | 403: Forbidden</title></html>"))).toBe("error");
  expect(oneTapFailureReason(refusal(400, { message: "Email verification is required" }))).toBe("error");
  expect(oneTapFailureReason(refusal(400, { message: "invalid id token" }))).toBe("error");
  expect(oneTapFailureReason(refusal(429, { message: "Too many requests. Please try again later." }))).toBe("error");
  expect(oneTapFailureReason(new TypeError("Failed to fetch"))).toBe("error");
});

test("One Tap needs FedCM and a secure page", () => {
  expect(browserSupportsOneTap({ IdentityCredential: function IdentityCredential() {}, isSecureContext: true })).toBe(true);
  expect(browserSupportsOneTap({ isSecureContext: true })).toBe(false);
  expect(browserSupportsOneTap({ IdentityCredential: function IdentityCredential() {}, isSecureContext: false })).toBe(false);
});
