import type { ExperimentAnswer, StorageLike } from "./web-experiments";

/**
 * `upgrade_personalized`: the upgrade sheet and onboarding's Pro step name
 * the account's own holdings, or the tickers it watches, instead of the
 * generic line. The registry, the arm and the stop
 * switch live with the API (gloomberb-platform `shared/experiments.ts`); the
 * unit is the signed-in free account, so the same person gets the same arm in
 * the terminal, the desktop app, the web terminal and on gloom.sh/cloud.
 *
 * The tickers never leave the device: the exposure carries the experiment and
 * where it was shown, nothing about the holdings.
 */
export const UPGRADE_PERSONALIZED = "upgrade_personalized";

export type UpgradePersonalizedVariant = "control" | "personalized";

export interface UpgradeExperimentContext {
  accountId?: string;
  pro: boolean;
  optedOut: boolean;
  automated: boolean;
  /** Keeps this session's answer across reloads where there is one (web, desktop). */
  session?: StorageLike;
}

const SESSION_PREFIX = "gloomberb.upgrade-personalized.exposed:";

function unit(context: UpgradeExperimentContext): string | undefined {
  if (!context.accountId || context.pro || context.optedOut || context.automated) return undefined;
  return `account:${context.accountId}`;
}

function isVariant(value: unknown): value is UpgradePersonalizedVariant {
  return value === "control" || value === "personalized";
}

function read(storage: StorageLike | undefined, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function write(storage: StorageLike | undefined, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* Storage is optional in private browsing. */ }
}

/**
 * One exposure per account and session. An accepted arm, or the API's "not in
 * the experiment", is kept for the session; a failed request (offline, an API
 * that does not know the experiment yet, a timeout) is not an exposure and is
 * asked again by the next surface.
 */
export function createUpgradeExperimentSession() {
  const answers = new Map<string, UpgradePersonalizedVariant | null>();
  const pending = new Map<string, Promise<UpgradePersonalizedVariant | null>>();

  function known(context: UpgradeExperimentContext): UpgradePersonalizedVariant | null | undefined {
    const identity = unit(context);
    if (!identity) return null;
    if (answers.has(identity)) return answers.get(identity);
    const saved = read(context.session, `${SESSION_PREFIX}${identity}`);
    if (saved === "excluded") return null;
    return isVariant(saved) ? saved : undefined;
  }

  return {
    /** The arm already answered in this session, null outside it, undefined when not asked yet. */
    known,
    expose(
      context: UpgradeExperimentContext,
      ask: () => Promise<ExperimentAnswer>,
    ): Promise<UpgradePersonalizedVariant | null> {
      const identity = unit(context);
      if (!identity) return Promise.resolve(null);
      const previous = known(context);
      if (previous !== undefined) return Promise.resolve(previous);
      const inFlight = pending.get(identity);
      if (inFlight) return inFlight;
      const request = (async () => {
        let answer: ExperimentAnswer;
        try { answer = await ask(); } catch { return null; }
        const variant = answer.accepted && isVariant(answer.variant) ? answer.variant : null;
        answers.set(identity, variant);
        write(context.session, `${SESSION_PREFIX}${identity}`, variant ?? "excluded");
        return variant;
      })().finally(() => pending.delete(identity));
      pending.set(identity, request);
      return request;
    },
  };
}
