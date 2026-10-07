import { EXPERIMENTS_STORAGE_KEY, storedExperimentAssignments, type ExperimentAnswer, type StorageLike } from "./web-experiments";

export type WallExperiment = "wall_teaser" | "wall_teaser_signin";

export type WallTeaserVariant = "control" | "teaser";

export interface WallExperimentContext {
  surface: "web" | "desktop" | "tui" | "cli";
  accountId?: string;
  pro: boolean;
  anonymousId?: string;
  optedOut: boolean;
  automated: boolean;
  /** Only the hosted browser carries a visitor's first arm between visits. */
  local?: StorageLike;
  session?: StorageLike;
}

function unit(context: WallExperimentContext, experiment: WallExperiment): string | undefined {
  if (context.pro || context.optedOut || context.automated) return undefined;
  if (experiment === "wall_teaser_signin" && context.accountId) return undefined;
  if (context.accountId) return `account:${context.accountId}`;
  if (context.surface === "web" && context.anonymousId) return `visitor:${context.anonymousId}`;
  return undefined;
}

function read(storage: StorageLike | undefined, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function write(storage: StorageLike | undefined, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* Storage is optional in private browsing. */ }
}

function isVariant(value: unknown): value is WallTeaserVariant {
  return value === "control" || value === "teaser";
}

function storedVariant(local: StorageLike | undefined, experiment: WallExperiment): WallTeaserVariant | undefined {
  if (!local) return undefined;
  const value = storedExperimentAssignments(local)?.split(",").find((part) => part.startsWith(`${experiment}:`))?.split(":")[1];
  return isVariant(value) ? value : undefined;
}

/** Isolated from the live trial-offer experiment: these sessions are keyed by their actual unit. */
export function createWallExperimentSession(experiment: WallExperiment = "wall_teaser") {
  const sessionPrefix = experiment === "wall_teaser"
    ? "gloomberb.wall-teaser.exposed:"
    : "gloomberb.wall-teaser-signin.exposed:";
  const answers = new Map<string, WallTeaserVariant | null>();
  const pending = new Map<string, Promise<WallTeaserVariant | null>>();

  function known(context: WallExperimentContext): WallTeaserVariant | null | undefined {
    const identity = unit(context, experiment);
    if (!identity) return null;
    if (answers.has(identity)) return answers.get(identity);
    const saved = read(context.session, `${sessionPrefix}${identity}`);
    if (saved === "excluded") return null;
    return isVariant(saved) ? saved : undefined;
  }

  return {
    /** An accepted arm for attribution, never a remembered arm from an earlier visit. */
    variant(context: WallExperimentContext): WallTeaserVariant | undefined {
      return known(context) ?? undefined;
    },
    expose(
      context: WallExperimentContext,
      ask: (variant: WallTeaserVariant | undefined) => Promise<ExperimentAnswer>,
    ): Promise<WallTeaserVariant | null> {
      const identity = unit(context, experiment);
      if (!identity) return Promise.resolve(null);
      const previous = known(context);
      if (previous !== undefined) return Promise.resolve(previous);
      const inFlight = pending.get(identity);
      if (inFlight) return inFlight;

      const request = (async () => {
        let answer: ExperimentAnswer;
        try { answer = await ask(storedVariant(context.local, experiment)); } catch {
          // An older API (422), offline connection or timeout is not an exposure.
          return null;
        }
        const variant = answer.accepted && isVariant(answer.variant) ? answer.variant : null;
        answers.set(identity, variant);
        write(context.session, `${sessionPrefix}${identity}`, variant ?? "excluded");
        // A stopped experiment must win over an arm retained from a previous visit.
        if (!variant) return null;
        if (context.local && !storedVariant(context.local, experiment)) {
          const existing = storedExperimentAssignments(context.local);
          const next = existing ? `${existing},${experiment}:${variant}` : `${experiment}:${variant}`;
          if (next.length <= 500) write(context.local, EXPERIMENTS_STORAGE_KEY, next);
        }
        return variant;
      })().finally(() => pending.delete(identity));
      pending.set(identity, request);
      return request;
    },
  };
}
