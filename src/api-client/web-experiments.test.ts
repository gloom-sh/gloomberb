import { describe, expect, test } from "bun:test";
import {
  EXPERIMENTS_STORAGE_KEY,
  exposeExperiment,
  storedExperimentAssignments,
  type ExperimentAnswer,
  type ExperimentExposureRequest,
  type WebExperimentEnvironment,
} from "./web-experiments";

const ANON = "0f1e2d3c-4b5a-4968-8776-655443322110";
const KEY = "web_terminal_trial_offer";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function environment(
  answer: (request: ExperimentExposureRequest) => Promise<ExperimentAnswer>,
  overrides: Partial<WebExperimentEnvironment> = {},
) {
  const asked: ExperimentExposureRequest[] = [];
  const env: WebExperimentEnvironment = {
    anonymousId: ANON,
    signedIn: false,
    automated: false,
    local: memoryStorage(),
    session: memoryStorage(),
    ask: (request) => {
      asked.push(request);
      return answer(request);
    },
    ...overrides,
  };
  return { env, asked };
}

describe("exposeExperiment", () => {
  test("asks once per browser session and keeps the first arm for later visits", async () => {
    const local = memoryStorage();
    const first = environment(async () => ({ accepted: true, variant: "offer" }), { local });
    expect(await exposeExperiment(KEY, first.env)).toBe("offer");
    expect(await exposeExperiment(KEY, first.env)).toBeNull();
    expect(first.asked).toEqual([{ experiment: KEY, variant: undefined }]);
    expect(storedExperimentAssignments(local)).toBe(`${KEY}:offer`);

    // A new session asks again and sends the arm it was given, which the API keeps.
    const later = environment(async () => ({ accepted: true, variant: "offer" }), { local });
    expect(await exposeExperiment(KEY, later.env)).toBe("offer");
    expect(later.asked).toEqual([{ experiment: KEY, variant: "offer" }]);
  });

  test("a page that asks twice while the first answer is pending sends one exposure", async () => {
    const { promise, resolve } = Promise.withResolvers<ExperimentAnswer>();
    const { env, asked } = environment(() => promise);
    const both = Promise.all([exposeExperiment(KEY, env), exposeExperiment(KEY, env)]);
    resolve({ accepted: true, variant: "control" });
    expect(await both).toEqual(["control", "control"]);
    expect(asked).toHaveLength(1);
  });

  test("never asks for signed-in, opted-out or automated browsers", async () => {
    for (const overrides of [
      { signedIn: true },
      // Do Not Track and Global Privacy Control leave the terminal without an id.
      { anonymousId: undefined },
      { automated: true },
    ] satisfies Partial<WebExperimentEnvironment>[]) {
      const { env, asked } = environment(async () => ({ accepted: true, variant: "offer" }), overrides);
      expect(await exposeExperiment(KEY, env)).toBeNull();
      expect(asked).toHaveLength(0);
      expect(env.local.getItem(EXPERIMENTS_STORAGE_KEY)).toBeNull();
    }
  });

  test("shows nothing when the API leaves the visitor out, and stops asking this session", async () => {
    const { env, asked } = environment(async () => ({ accepted: false }));
    expect(await exposeExperiment(KEY, env)).toBeNull();
    expect(await exposeExperiment(KEY, env)).toBeNull();
    expect(asked).toHaveLength(1);
    expect(env.local.getItem(EXPERIMENTS_STORAGE_KEY)).toBeNull();
  });

  test("a failed request shows nothing and is not counted, so a later load can ask again", async () => {
    const session = memoryStorage();
    const failing = environment(async () => {
      throw new Error("offline");
    }, { session });
    expect(await exposeExperiment(KEY, failing.env)).toBeNull();
    const retry = environment(async () => ({ accepted: true, variant: "offer" }), { session });
    expect(await exposeExperiment(KEY, retry.env)).toBe("offer");
  });
});
