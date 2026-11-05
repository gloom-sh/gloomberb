/**
 * Google One Tap on the hosted terminal, the `one_tap` arm of the
 * `web_terminal_one_tap` experiment, without React: when a signed-out visitor
 * becomes eligible, both arms are asked for and counted at that moment, and
 * only `one_tap` asks Google for the prompt.
 *
 * Eligible means the visitor has used the terminal: they opened a function of
 * their own (a command, a ticker's research, Help; restoring the workspace
 * does not count) and the terminal has been on screen for a minute, counted
 * only while the tab is visible. The minute keeps the prompt off the first
 * impression and away from a tab left open in the background; the function
 * keeps it from someone who only glanced at the starter screen. Nothing is
 * asked while a dialog or the command bar is open: it waits until they close.
 *
 * After a prompt that ends without a sign-in (closed, skipped, or Google not
 * showing it) the prompt stays away for 7 days; Google lengthens its own
 * cooldown on top of that each time someone closes it. A dialog or the
 * command bar opening over the prompt cancels it, and it is asked again once
 * they close; that is not a dismissal.
 */
import { ApiRequestError } from "../../../../api-client/errors";
import { logFailure } from "../../../../utils/log-failure";
import { describeMoment, type GoogleCredentialResponse, type GoogleIdApi, type GooglePromptNotification } from "./google-identity";

export const ONE_TAP_EXPERIMENT = "web_terminal_one_tap";
const ONE_TAP_ARM = "one_tap";
/** On-screen time, with a function opened, before the visitor counts as using the terminal. */
export const ONE_TAP_ON_SCREEN_MS = 60_000;
/** How long a prompt that ended without a sign-in stays away. */
export const ONE_TAP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
/** Prompts asked again after the terminal cancelled one for a dialog, per page. */
const MAX_REPROMPTS = 2;

type OneTapEvent =
  | "one_tap_prompted"
  | "one_tap_shown"
  | "one_tap_not_shown"
  | "one_tap_skipped"
  | "one_tap_dismissed"
  | "one_tap_signed_in"
  | "one_tap_failed";

export type OneTapFailure = "account_not_linked" | "email_not_verified" | "error";

/** Why a One Tap sign-in the server refused did not go through. */
export function oneTapFailureReason(error: unknown): OneTapFailure {
  if (error instanceof ApiRequestError) {
    if (/not linked/i.test(error.message)) return "account_not_linked";
    if (error.status === 403 || /verif/i.test(error.message)) return "email_not_verified";
  }
  return "error";
}

function isOneTapSnoozed(snoozedAt: number | null, now: number): boolean {
  return snoozedAt !== null && now - snoozedAt >= 0 && now - snoozedAt < ONE_TAP_SNOOZE_MS;
}

export interface OneTapDeps {
  /** Asks the API for the arm, which counts the exposure; null shows nothing. */
  expose(): Promise<string | null>;
  /** The Google client id; fails while the server has One Tap off. */
  clientId(): Promise<string>;
  /** Google's `google.accounts.id`, loaded on first use. */
  google(): Promise<GoogleIdApi>;
  /** Signs in with the ID token; rejects with the server's refusal. */
  signIn(credential: string): Promise<void>;
  record(event: OneTapEvent, reason?: string): void;
  snoozedAt(): number | null;
  snooze(at: number): void;
  onScreenMs?: number;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface OneTapConditions {
  /** The terminal's tab can be seen. */
  visible?: boolean;
  signedOut?: boolean;
  /** A dialog or the command bar is open. */
  overlayOpen?: boolean;
}

/**
 * `waiting` for eligibility, `exposing` while the arm is asked for, `loading`
 * Google's script, `paused` with the prompt ready but held back (an overlay),
 * `prompting` while Google has it, `signing-in`, and `done`.
 */
export type OneTapPhase = "waiting" | "exposing" | "loading" | "paused" | "prompting" | "signing-in" | "done";

export class OneTapController {
  private phaseValue: OneTapPhase = "waiting";
  private visible = false;
  private visibleSince: number | null = null;
  private onScreenMs = 0;
  private timeReached = false;
  private timer: unknown = null;
  private opened = false;
  private signedOut = false;
  private overlayOpen = false;
  private google: GoogleIdApi | null = null;
  private reprompts = 0;
  private readonly threshold: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: OneTapDeps) {
    this.threshold = deps.onScreenMs ?? ONE_TAP_ON_SCREEN_MS;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get phase(): OneTapPhase {
    return this.phaseValue;
  }

  update(conditions: OneTapConditions): void {
    if (this.phaseValue === "done") return;
    if (conditions.visible !== undefined) this.setVisible(conditions.visible);
    if (conditions.signedOut !== undefined) this.signedOut = conditions.signedOut;
    if (conditions.overlayOpen !== undefined) this.overlayOpen = conditions.overlayOpen;
    if (!this.signedOut && this.phaseValue !== "waiting" && this.phaseValue !== "signing-in") {
      // Signed in some other way (another tab, the Log in dialog).
      this.cancelPrompt();
      this.finish();
      return;
    }
    if (this.overlayOpen && this.phaseValue === "prompting") {
      // Held back, and asked again once the overlay closes. Set before the
      // cancel, whose notification may arrive within it.
      this.reprompts += 1;
      this.phaseValue = "paused";
      this.cancelPrompt();
      if (this.reprompts > MAX_REPROMPTS) this.finish();
      return;
    }
    this.advance();
  }

  /** The visitor opened a function themselves. */
  noteFunctionOpen(): void {
    if (this.opened) return;
    this.opened = true;
    this.advance();
  }

  dispose(): void {
    if (this.phaseValue === "prompting") this.cancelPrompt();
    this.finish();
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    const now = this.now();
    if (this.visible && this.visibleSince !== null) this.onScreenMs += now - this.visibleSince;
    this.visible = visible;
    this.visibleSince = visible ? now : null;
    this.armTimer();
  }

  /** Counts on-screen time toward the minute; the timer runs only while the tab is visible. */
  private armTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.timeReached || !this.visible || this.phaseValue !== "waiting") return;
    const remaining = this.threshold - this.onScreenMs;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timeReached = true;
      this.advance();
    }, Math.max(0, remaining));
  }

  private advance(): void {
    if (this.phaseValue === "waiting") {
      if (this.signedOut && this.opened && this.timeReached && !this.overlayOpen) void this.expose();
      return;
    }
    if (this.phaseValue === "paused" && !this.overlayOpen && this.signedOut) this.prompt();
  }

  private async expose(): Promise<void> {
    this.phaseValue = "exposing";
    const variant = await this.deps.expose().catch(logFailure("cloud-one-tap", "One Tap exposure failed", null));
    if (this.phaseValue !== "exposing") return;
    if (variant !== ONE_TAP_ARM || !this.signedOut) {
      this.finish();
      return;
    }
    if (isOneTapSnoozed(this.deps.snoozedAt(), this.now())) {
      this.deps.record("one_tap_not_shown", "snoozed");
      this.finish();
      return;
    }
    this.phaseValue = "loading";
    let clientId: string;
    let google: GoogleIdApi;
    try {
      clientId = await this.deps.clientId();
    } catch {
      // Intentional ignore: One Tap is off on the server; nothing shows.
      this.notShown("unavailable");
      return;
    }
    try {
      google = await this.deps.google();
    } catch {
      // Intentional ignore: blocked or offline; nothing shows.
      this.notShown("library_failed");
      return;
    }
    if (this.phaseValue !== "loading") return;
    google.initialize({
      client_id: clientId,
      callback: (response) => void this.credential(response),
      // A click on the prompt, never a silent sign-in.
      auto_select: false,
      cancel_on_tap_outside: true,
      // "Use term.gloom.sh with google.com": it signs in or up.
      context: "use",
      use_fedcm_for_prompt: true,
    });
    this.google = google;
    this.phaseValue = "paused";
    this.advance();
  }

  private prompt(): void {
    const google = this.google;
    if (!google) return;
    this.phaseValue = "prompting";
    this.deps.record("one_tap_prompted");
    try {
      google.prompt((notification) => this.moment(notification));
    } catch {
      // Intentional ignore: Google's script refused; nothing shows.
      this.notShown("library_failed");
    }
  }

  private moment(notification: GooglePromptNotification): void {
    const moment = describeMoment(notification);
    if (!moment) return;
    if (moment.event === "one_tap_shown") {
      this.deps.record("one_tap_shown");
      return;
    }
    this.deps.record(moment.event, moment.reason);
    // credential_returned: the callback signs in. cancel_called: the terminal
    // held it back for an overlay. flow_restarted: another prompt took over.
    if (moment.event === "one_tap_dismissed") return;
    // Only a prompt still out counts: a cancelled one is not the visitor's answer.
    if (this.phaseValue === "prompting") {
      // Closed, tapped away from, or not shown by Google: not again for a while.
      this.deps.snooze(this.now());
      this.finish();
    }
  }

  private async credential(response: GoogleCredentialResponse): Promise<void> {
    if (!response.credential || this.phaseValue === "done" || this.phaseValue === "signing-in") return;
    this.phaseValue = "signing-in";
    try {
      await this.deps.signIn(response.credential);
      this.deps.record("one_tap_signed_in");
    } catch (error) {
      this.deps.record("one_tap_failed", oneTapFailureReason(error));
    }
    this.finish();
  }

  private notShown(reason: string): void {
    this.deps.record("one_tap_not_shown", reason);
    this.finish();
  }

  private cancelPrompt(): void {
    try {
      this.google?.cancel();
    } catch {
      // Intentional ignore: nothing left to cancel.
    }
  }

  private finish(): void {
    this.phaseValue = "done";
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
