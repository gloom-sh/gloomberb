/**
 * A/B experiments on the hosted web terminal (term.gloom.sh).
 *
 * The registry, the bucketing and the bot rules live with the API
 * (gloomberb-platform `shared/experiments.ts`). The terminal asks for its arm
 * at the moment an experiment's change would show, in every arm, and that
 * request is the exposure: the API answers with the variant and counts the
 * visitor in it. Turning an experiment off there takes effect here without a
 * release.
 *
 * The first variant this browser is given is kept and sent back, so a visitor
 * whose anonymous id changes later stays in the same arm, and it rides on every
 * later milestone as `experiments`, which the API turns into `exp_<key>` and
 * saves to the account once they sign in.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ExperimentAnswer {
  accepted: boolean;
  variant?: string;
}

export interface ExperimentExposureRequest {
  experiment: string;
  /** The variant this browser was given before, if any. */
  variant?: string;
}

export interface WebExperimentEnvironment {
  /** Absent with Do Not Track or Global Privacy Control: the terminal never minted one. */
  anonymousId: string | undefined;
  signedIn: boolean;
  /** A browser driven by automation (`navigator.webdriver`). */
  automated: boolean;
  /** Kept across visits: the first variant of each experiment. */
  local: StorageLike;
  /** Kept for this browser session: the experiments already counted in it. */
  session: StorageLike;
  ask(request: ExperimentExposureRequest): Promise<ExperimentAnswer>;
}

export const EXPERIMENTS_STORAGE_KEY = "gloomberb.web.experiments";
const EXPOSED_SESSION_KEY = "gloomberb.web.experiments-exposed";

const ASSIGNMENT = /^([a-z][a-z0-9_]{0,47}):([a-z][a-z0-9_]{0,47})$/;
const MAX_ASSIGNMENTS_LENGTH = 500;

/** "web_terminal_trial_offer:offer,other:control", the API's format, to an ordered map. */
function parseExperimentAssignments(value: string | null | undefined): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const part of (value ?? "").split(",")) {
    const match = ASSIGNMENT.exec(part.trim());
    if (match && !assignments.has(match[1]!)) assignments.set(match[1]!, match[2]!);
  }
  return assignments;
}

function serializeExperimentAssignments(assignments: ReadonlyMap<string, string>): string | undefined {
  let serialized = "";
  for (const [key, variant] of assignments) {
    const part = `${key}:${variant}`;
    if (!ASSIGNMENT.test(part)) continue;
    const next = serialized ? `${serialized},${part}` : part;
    if (next.length > MAX_ASSIGNMENTS_LENGTH) break;
    serialized = next;
  }
  return serialized || undefined;
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* Private browsing still runs the terminal; the arm is just not remembered. */
  }
}

/** The stored assignments as the attribution string, or undefined when there are none. */
export function storedExperimentAssignments(storage: StorageLike): string | undefined {
  return serializeExperimentAssignments(parseExperimentAssignments(read(storage, EXPERIMENTS_STORAGE_KEY)));
}

const pending = new Map<string, Promise<string | null>>();

/**
 * The variant to show, or null to show nothing: the visitor is signed in, has
 * no anonymous id, is an automated browser, was already counted in this
 * browser session, or the API did not put them in the experiment (a bot, the
 * experiment ended, the request failed). Call it when the change would show,
 * in every arm.
 */
export function exposeExperiment(experiment: string, env: WebExperimentEnvironment): Promise<string | null> {
  if (!env.anonymousId || env.signedIn || env.automated) return Promise.resolve(null);
  if (parseSessionList(read(env.session, EXPOSED_SESSION_KEY)).has(experiment)) return Promise.resolve(null);
  const inFlight = pending.get(experiment);
  if (inFlight) return inFlight;

  const request = (async () => {
    const assignments = parseExperimentAssignments(read(env.local, EXPERIMENTS_STORAGE_KEY));
    let answer: ExperimentAnswer;
    try {
      answer = await env.ask({ experiment, variant: assignments.get(experiment) });
    } catch {
      // Not counted, so the next page load in this session may ask again.
      return null;
    }
    const exposed = parseSessionList(read(env.session, EXPOSED_SESSION_KEY));
    exposed.add(experiment);
    write(env.session, EXPOSED_SESSION_KEY, [...exposed].join(","));
    if (!answer.accepted || !answer.variant || !ASSIGNMENT.test(`${experiment}:${answer.variant}`)) return null;
    if (!assignments.has(experiment)) {
      assignments.set(experiment, answer.variant);
      const serialized = serializeExperimentAssignments(assignments);
      if (serialized) write(env.local, EXPERIMENTS_STORAGE_KEY, serialized);
    }
    return answer.variant;
  })().finally(() => pending.delete(experiment));
  pending.set(experiment, request);
  return request;
}

function parseSessionList(value: string | null): Set<string> {
  return new Set((value ?? "").split(",").filter(Boolean));
}
